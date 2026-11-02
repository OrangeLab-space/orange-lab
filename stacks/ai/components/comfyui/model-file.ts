import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ComfyUIFile {
    path: string;
    url: string;
}

export interface ComfyUINodeMapping {
    key?: string;
    node_ids: string[];
    type: string;
}

export interface ComfyUIModelFile {
    /** Files preloaded into the node-local cache. */
    files: ComfyUIFile[];
    /** Model name Open WebUI passes into the workflow. */
    model: string;
    nodes: ComfyUINodeMapping[];
    workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
}

/**
 * Loads the `comfyui:modelFile` JSON: a ComfyUI API workflow plus the model
 * name, node mapping and files to download. Relative paths resolve against the
 * stack directory, where `pulumi up` runs.
 */
export function loadComfyUIModelFile(path: string): ComfyUIModelFile {
    const file = resolve(path);
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        // eslint-disable-next-line preserve-caught-error -- tsconfig targets es2016, which has no Error cause
        throw new Error(
            `Cannot read ComfyUI model file '${file}': ${errorMessage(error)}`,
        );
    }
    return parseModelFile(raw, file);
}

function parseModelFile(raw: unknown, file: string): ComfyUIModelFile {
    if (!isRecord(raw)) throw new Error(`${file}: expected a JSON object.`);

    const { files, model, nodes, workflow } = raw;
    if (typeof model !== 'string' || !model) {
        throw new Error(`${file}: 'model' must be a non-empty string.`);
    }
    if (!Array.isArray(nodes) || nodes.length === 0) {
        throw new Error(`${file}: 'nodes' must be a non-empty list.`);
    }
    if (!isRecord(workflow) || Object.keys(workflow).length === 0) {
        throw new Error(`${file}: 'workflow' must be a non-empty object.`);
    }

    return {
        files: parseFiles(files, file),
        model,
        nodes: nodes.map((node, index) =>
            parseNode(node, `${file}: nodes[${String(index)}]`),
        ),
        workflow: workflow as ComfyUIModelFile['workflow'],
    };
}

function parseFiles(value: unknown, file: string): ComfyUIFile[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        throw new Error(`${file}: 'files' must be a list.`);
    }
    return value.map((entry, index) => {
        const path = `${file}: files[${String(index)}]`;
        if (!isRecord(entry)) throw new Error(`${path} must be an object.`);

        const { path: target, url } = entry;
        if (typeof url !== 'string' || !url) {
            throw new Error(`${path}.url must be a non-empty string.`);
        }
        if (
            typeof target !== 'string' ||
            !target ||
            target.startsWith('/') ||
            target.includes('..')
        ) {
            throw new Error(`${path}.path must be relative to /data, without '..'.`);
        }
        return { path: target, url };
    });
}

function parseNode(value: unknown, path: string): ComfyUINodeMapping {
    if (!isRecord(value)) throw new Error(`${path} must be an object.`);

    const { key, node_ids: nodeIds, type } = value;
    if (typeof type !== 'string' || !type) {
        throw new Error(`${path}.type must be a non-empty string.`);
    }
    if (
        !Array.isArray(nodeIds) ||
        nodeIds.length === 0 ||
        nodeIds.some(id => typeof id !== 'string')
    ) {
        throw new Error(`${path}.node_ids must be a non-empty list of strings.`);
    }
    if (key !== undefined && typeof key !== 'string') {
        throw new Error(`${path}.key must be a string.`);
    }

    return {
        ...(key ? { key } : {}),
        node_ids: nodeIds as string[],
        type,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
