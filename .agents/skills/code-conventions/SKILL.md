---
name: code-conventions
description: Use when creating or editing TypeScript code in the orange-lab repo — stacks, components (`stacks/<module>/components/`, `components/`), or the `@orangelab/pulumi` library (`packages/pulumi/src/`). Covers code style, component patterns, Pulumi config conventions, and secrets handling. Not needed for markdown/documentation-only changes.
---

# Code Conventions

## Code Style

- TypeScript with strict type checking. `npm test` runs tsc + eslint; eslint enforces no-`any`, `??` over `||`, optional chaining, and `_` prefix for unused variables — don't restate these in code comments or reviews
- Prefer self-documenting code over comments; descriptive variable names and clear function signatures
- Keep code concise — omit default values unless useful to communicate intent
- Pass dependencies through args (providers, config, metadata) rather than accessing globals (except `config.ts`)
- camelCase for variables, functions, methods; PascalCase for classes, interfaces, type aliases
- Group imports external packages first, then internal modules; sort alphabetically within each group
- Use `assert` for validations that should never fail
- Prefer `variable?: Type` over `variable: Type | undefined`
- Keep methods around 20 lines or less; inline simple operations (single `.map()`, `.filter()`) rather than extracting private methods; orchestration methods coordinating multiple steps may be longer
- Prefer standard Kubernetes conventions unless there's a specific reason to deviate (e.g. node-role labels use `true` value to match k3s `control-plane` and `master` roles)

## Components

- Follow the established pattern for new modules and components
- Use constructor parameter properties with access modifiers (e.g., `constructor(private readonly args: Args)`)
- Prefer composition over inheritance for component relationships
- Only export fields when needed for external use; keep sensitive values like auth keys internal when not required
- Share provider instances across components (pass via args) rather than creating duplicates

### Initialization Order

When a value from `Application` (like `this.app.debug`) is needed during chained initialization, create the Application instance first: `this.app = new Application(...);`, then continue with chained methods: `this.app.addStorage().addConfigVolume(...)`.

## Shell Scripts & Tooling

- Scripts under `scripts/` are generic tools driven entirely by explicit arguments. They must not read app-specific Pulumi config or infer app-specific names.
- App-specific knowledge (stack outputs, `auth/*` values, group/client names) stays in the per-app wrapper that calls the shared script, which passes explicit parameters. Example: `pocket-<app>.sh` reads its `<app>:auth/allowedGroups` (unset = unrestricted) and passes them as `--restrict-access "admin,power-user"`; `scripts/pocket-client.sh` only acts on the arguments it is given.
- An existing group is reused, never modified, so members are not dropped.
- If a shared tool needs something from another component's config to work, pass it as a parameter instead of reading it — and raise the new coupling for discussion first (see AGENTS.md).

## Configuration

- **Pulumi stack files**: Never modify or read `Pulumi.*.yaml` files directly — they may contain secrets. Use `pulumi config set/get` (`--secret` for sensitive values).
- Use `config.require()` instead of `config.get()` when a default value exists in `Pulumi.yaml`; don't use optional accessors (`?.`, `??`) for such settings. This prevents typos and simplifies processing logic
- **Feature-gated validation**: When a feature is conditionally enabled (e.g., `smtp/enabled`), validate its required settings only when enabled. `Pulumi.yaml` can then carry defaults for optional features without forcing users to set them
- **Conditional requirements**: When a feature is enabled, all its related settings should typically be required — the `enabled` flag acts as the conditional gate
- **No installation-specific values as defaults**: `Pulumi.yaml` is published to every user, so a default must be meaningful for anyone. Never put a real domain, hostname, node name, IP, account or group name in it — the developer's own values are not the generic case. Comment the key out with a `#` example value and say whether it is required; it then belongs in the user's `Pulumi.<stack>.yaml`. Required settings use `config.require()` so the deploy fails with a clear message rather than silently substituting the author's environment. Optional ones use `config.get()` and leave the feature genuinely absent when unset — do not invent a fallback URL or redirect that only makes sense for the author (e.g. `caddy:rootRedirect`). Note `pulumi config get` resolves `Pulumi.yaml` defaults, so a default left in place is active, not inert.
- **Minimal config generation**: Only generate config files (ConfigMaps/Secrets) when a feature requiring them is enabled
- **Derive don't duplicate**: Values that can be derived from existing resources (like URLs from `HttpEndpointInfo`) should be derived, not manually configured
- **Naming**: Settings that map to container environment variables use the exact env var name (e.g. `DNS_SERVER_FORWARDERS` instead of `forwarders`). Exception: settings that are standardized across apps (shared semantics regardless of the app's env var name) use a generic namespace and the component maps them to the app-specific env var — e.g. `auth/clientId`, `auth/clientSecret`, `auth/providerUrl`, `auth/providerName` map to `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OPENID_PROVIDER_URL`, `OAUTH_PROVIDER_NAME` in Open WebUI (and the equivalent vars in other apps). Use this only for genuinely cross-app settings, not for one-off app-specific knobs.

### Pulumi.yaml Layout

These apply to `Pulumi.yaml` in the core stack and to every module's `Pulumi.yaml`:

- **One blank line between apps.** Each app's settings form a contiguous block; the next app starts after a blank line. Core also groups them under `### SECTION ###` headers (Network, Storage, Hardware, ...), with a blank line after each header.
- **A commented-out key is a disabled setting, not a comment.** Treat it as part of the settings list — it needs no separator around it, and it never counts toward the comment length limit.
- **Separate prose from the next setting with a bare `#` line.** Only when a *prose* comment (text explaining why, not a commented-out key) would otherwise run into an unrelated setting, insert a lone `#` so a reader can tell where the note ends. Do not add one after commented-out keys — they read as settings already.
- **Comments are 1–2 lines, 3 maximum.** A comment says what the setting is and when it is required — nothing else. Anything longer belongs in the component's `<app>.md`, referenced by path. If the reason does not fit, the setting probably needs a better name or a code-level check instead of a prose explanation.
- **A commented-out key is a placeholder, not a disabled default.** Show the shape (`# caddy:rootRedirect: https://example.com`) so users know what to type, and use generic example values.

## Secrets

- Use `envSecret` field in `ContainerSpec` for sensitive data instead of command args — the Application class automatically creates Kubernetes Secrets and configures envFrom
- Environment variable names should be UPPERCASE
- Never expose passwords or sensitive data in command line arguments

### Restore-critical Secrets

If a secret protects data at rest (encryption keys, credentials stored in the app's database/volume), read it with `config.requireSecret()` - a missing value must fail the deploy instead of silently breaking volume restores. Document it in the component docs:

1. Generation + `pulumi config set --secret` in the deployment block (before first `pulumi up`)
2. Why it must stay stable across restores

Example: n8n, open-webui, nextcloud adminPassword, rustfs rootPassword, prometheus grafana/password

### Rotation-safe Secrets

Login passwords or external credentials that don't protect restored data may keep an auto-generated fallback (`config.getSecret(...) ?? createPassword(...)`). Docs should instruct retrieving from stack outputs and persisting with `--secret` for stability, but rotation is acceptable.

Example: slskd, technitium, immich JWT_SECRET, vaultwarden adminToken

Never read secret config values with `config.get()` - it returns undefined for `--secret` entries; use `config.getSecret()`/`requireSecret()`.
