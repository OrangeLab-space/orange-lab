"""ComfyUI image generation backend: submits the cluster's workflow to ComfyUI.

No API key and no bundled graph. The only workflow is the one
`comfyui:modelFile` defines, seeded as `image_gen.comfyui.workflow_file`, so the
graph always names models the server was told to download.
"""

from __future__ import annotations

import json
import logging
import os
import random
import time
import urllib.parse
import urllib.request
import uuid
from typing import Any, Optional

from agent.image_gen_provider import (
    DEFAULT_ASPECT_RATIO,
    ImageGenProvider,
    error_response,
    resolve_aspect_ratio,
    save_b64_image,
    success_response,
)

logger = logging.getLogger(__name__)

PROVIDER = "comfyui"
DEFAULT_URL = "http://127.0.0.1:8188"
SIZES = {"landscape": (1344, 768), "square": (1024, 1024), "portrait": (768, 1344)}


def _config() -> dict[str, Any]:
    try:
        from hermes_cli.config import load_config

        cfg = load_config()
        section = cfg.get("image_gen") if isinstance(cfg, dict) else None
        scoped = section.get("comfyui") if isinstance(section, dict) else None
        return scoped if isinstance(scoped, dict) else {}
    except Exception as exc:
        logger.debug("Could not load image_gen.comfyui config: %s", exc)
        return {}


def _base_url(cfg: Optional[dict[str, Any]] = None) -> str:
    cfg = _config() if cfg is None else cfg
    url = (os.environ.get("COMFYUI_URL") or cfg.get("base_url") or DEFAULT_URL).strip()
    return url.rstrip("/")


def _workflow_file(cfg: Optional[dict[str, Any]] = None) -> str:
    cfg = _config() if cfg is None else cfg
    return str(os.environ.get("COMFYUI_WORKFLOW_FILE") or cfg.get("workflow_file") or "").strip()


def _load_workflow(
    cfg: Optional[dict[str, Any]] = None,
) -> Optional[tuple[dict[str, Any], Optional[list[dict[str, Any]]], str]]:
    """`(graph, node mapping, model name)` from the seeded bundle, None when unset."""
    path = _workflow_file(cfg)
    if not path:
        return None
    with open(os.path.expanduser(path), encoding="utf-8") as fh:
        loaded = json.load(fh)
    if not isinstance(loaded, dict):
        return None
    graph = loaded.get("workflow") if isinstance(loaded.get("workflow"), dict) else loaded
    if not isinstance(graph, dict) or not graph:
        return None
    nodes = loaded.get("nodes")
    return graph, nodes if isinstance(nodes, list) else None, str(loaded.get("model") or "")


def _http_json(url: str, payload: Optional[dict[str, Any]] = None, timeout: float = 30.0) -> dict:
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - operator-configured host
        return json.loads(resp.read().decode())


def _patch_workflow(graph: dict[str, Any], prompt: str, size: tuple[int, int], seed: int,
                    prefix: str, nodes: Optional[list[dict[str, Any]]] = None) -> dict[str, Any]:
    """Copy the graph and inject prompt, size and seed; `nodes` names the prompt/seed nodes."""
    wf = json.loads(json.dumps(graph))
    mapped_prompt = False
    for mapping in nodes or []:
        if not isinstance(mapping, dict):
            continue
        kind, key = str(mapping.get("type") or ""), mapping.get("key")
        for node_id in mapping.get("node_ids") or []:
            inputs = (wf.get(str(node_id)) or {}).get("inputs")
            if not isinstance(inputs, dict):
                continue
            if kind == "prompt":
                inputs["text"] = prompt
                mapped_prompt = True
            elif kind == "seed" and key:
                inputs[str(key)] = seed
    for node in wf.values():
        ct, inputs = node.get("class_type", ""), node.get("inputs", {})
        if not mapped_prompt and ct == "CLIPTextEncode" and isinstance(inputs.get("text"), str):
            inputs["text"] = prompt
            mapped_prompt = True
        elif ct.startswith("Empty") and "width" in inputs and "height" in inputs:
            inputs["width"], inputs["height"] = size
        elif not nodes and ct in ("KSampler", "KSamplerAdvanced"):
            if "seed" in inputs:
                inputs["seed"] = seed
            if "noise_seed" in inputs:
                inputs["noise_seed"] = seed
        elif ct == "SaveImage":
            inputs["filename_prefix"] = prefix
    return wf


class ComfyUIImageGenProvider(ImageGenProvider):
    """Runs an API-format workflow on a ComfyUI server; no credentials required."""

    @property
    def name(self) -> str:
        return PROVIDER

    @property
    def display_name(self) -> str:
        return "ComfyUI (local server)"

    def is_available(self) -> bool:
        """True when a workflow is configured and its ComfyUI answers /system_stats."""
        try:
            if _load_workflow() is None:
                return False
            _http_json(f"{_base_url()}/system_stats", timeout=3.0)
            return True
        except Exception as exc:
            logger.debug("ComfyUI not available: %s", exc)
            return False

    def list_models(self) -> list[dict[str, Any]]:
        """The one model the configured workflow runs."""
        try:
            workflow = _load_workflow()
        except Exception:
            return []
        if workflow is None:
            return []
        model = workflow[2] or PROVIDER
        return [{"id": model, "display": model}]

    def default_model(self) -> Optional[str]:
        models = self.list_models()
        return str(models[0]["id"]) if models else None

    def get_setup_schema(self) -> dict[str, Any]:
        return {
            "env_vars": [
                {"name": "COMFYUI_URL", "label": "ComfyUI server URL",
                 "placeholder": DEFAULT_URL, "required": False},
                {"name": "COMFYUI_WORKFLOW_FILE", "label": "Workflow bundle",
                 "required": True},
            ],
            "help": "Point at a ComfyUI server and the workflow `comfyui:modelFile` "
                    "describes. No API key is needed.",
        }

    def capabilities(self) -> dict[str, Any]:
        return {"modalities": ["text"], "max_reference_images": 0}

    def generate(self, prompt: str, aspect_ratio: str = DEFAULT_ASPECT_RATIO, *,
                 image_url: Optional[str] = None, reference_image_urls: Optional[list[str]] = None,
                 **kwargs: Any) -> dict[str, Any]:
        aspect = resolve_aspect_ratio(aspect_ratio)
        cfg = _config()
        base = _base_url(cfg)
        try:
            workflow = _load_workflow(cfg)
        except Exception as exc:
            return error_response(error=f"Could not read workflow {_workflow_file(cfg)}: {exc}",
                                  error_type="invalid_argument", provider=PROVIDER,
                                  model=PROVIDER, prompt=prompt, aspect_ratio=aspect)
        if workflow is None:
            return error_response(
                error="No ComfyUI workflow configured: set image_gen.comfyui.workflow_file "
                      "to the bundle comfyui:modelFile describes.",
                error_type="invalid_argument", provider=PROVIDER, model=PROVIDER,
                prompt=prompt, aspect_ratio=aspect)
        graph, nodes, workflow_model = workflow
        model_id = str(kwargs.get("model") or workflow_model or PROVIDER)

        if not isinstance(prompt, str) or not prompt.strip():
            return error_response(error="Prompt is required and must be a non-empty string",
                                  error_type="invalid_argument", provider=PROVIDER,
                                  model=model_id, aspect_ratio=aspect)
        if image_url or reference_image_urls:
            return error_response(
                error="The comfyui backend is text-to-image only; image editing needs an image-to-image workflow",
                error_type="unsupported_capability", provider=PROVIDER, model=model_id,
                prompt=prompt, aspect_ratio=aspect)

        seed = int(kwargs.get("seed") or random.randrange(0, 2**31))
        prefix = workflow_model.rsplit(".", 1)[0] or PROVIDER
        wf = _patch_workflow(graph, prompt.strip(), SIZES[aspect], seed,
                             f"hermes-{prefix}", nodes)

        try:
            queued = _http_json(f"{base}/prompt", {"prompt": wf, "client_id": uuid.uuid4().hex})
        except Exception as exc:
            return error_response(error=f"ComfyUI at {base} rejected the workflow: {exc}",
                                  error_type="provider_error", provider=PROVIDER,
                                  model=model_id, prompt=prompt, aspect_ratio=aspect)
        prompt_id = queued.get("prompt_id")
        if not prompt_id:
            return error_response(error=f"ComfyUI returned no prompt_id: {queued}",
                                  error_type="provider_error", provider=PROVIDER,
                                  model=model_id, prompt=prompt, aspect_ratio=aspect)

        deadline = time.monotonic() + float(os.environ.get("COMFYUI_TIMEOUT", "600"))
        entry: dict[str, Any] = {}
        while time.monotonic() < deadline:
            time.sleep(1.5)
            try:
                hist = _http_json(f"{base}/history/{prompt_id}", timeout=30.0)
            except Exception as exc:
                logger.debug("history poll failed: %s", exc)
                continue
            entry = hist.get(prompt_id) or {}
            if entry:
                status = entry.get("status") or {}
                if status.get("status_str") == "error" or status.get("completed") is False and status.get("status_str"):
                    messages = json.dumps(status.get("messages", []))[:400]
                    return error_response(error=f"ComfyUI workflow failed: {messages}",
                                          error_type="provider_error", provider=PROVIDER,
                                          model=model_id, prompt=prompt, aspect_ratio=aspect)
                if entry.get("outputs"):
                    break

        outputs = (entry or {}).get("outputs") or {}
        image_meta: Optional[dict[str, Any]] = None
        for node_out in outputs.values():
            for key in ("images", "gifs"):
                if node_out.get(key):
                    image_meta = node_out[key][0]
                    break
            if image_meta:
                break
        if not image_meta:
            return error_response(error="ComfyUI finished without an image output (timeout or empty queue)",
                                  error_type="empty_response", provider=PROVIDER, model=model_id,
                                  prompt=prompt, aspect_ratio=aspect)

        query = urllib.parse.urlencode({"filename": image_meta.get("filename", ""),
                                        "subfolder": image_meta.get("subfolder", ""),
                                        "type": image_meta.get("type", "output")})
        try:
            with urllib.request.urlopen(f"{base}/view?{query}", timeout=120) as resp:  # noqa: S310
                raw = resp.read()
        except Exception as exc:
            return error_response(error=f"Could not download the image from ComfyUI: {exc}",
                                  error_type="provider_error", provider=PROVIDER,
                                  model=model_id, prompt=prompt, aspect_ratio=aspect)

        import base64

        try:
            path = save_b64_image(base64.b64encode(raw).decode(), prefix=prefix)
        except Exception as exc:
            return error_response(error=f"Could not cache the generated image: {exc}",
                                  error_type="io_error", provider=PROVIDER, model=model_id,
                                  prompt=prompt, aspect_ratio=aspect)

        return success_response(image=str(path), model=model_id, prompt=prompt,
                                aspect_ratio=aspect, provider=PROVIDER,
                                extra={"seed": seed, "workflow": workflow_model})


def register(ctx) -> None:
    """Registers the ComfyUI provider with the image_gen registry."""
    ctx.register_image_gen_provider(ComfyUIImageGenProvider())
