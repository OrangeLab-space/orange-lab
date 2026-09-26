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

## Configuration

- **Pulumi stack files**: Never modify or read `Pulumi.*.yaml` files directly — they may contain secrets. Use `pulumi config set/get` (`--secret` for sensitive values).
- Use `config.require()` instead of `config.get()` when a default value exists in `Pulumi.yaml`; don't use optional accessors (`?.`, `??`) for such settings. This prevents typos and simplifies processing logic
- **Feature-gated validation**: When a feature is conditionally enabled (e.g., `smtp/enabled`), validate its required settings only when enabled. `Pulumi.yaml` can then carry defaults for optional features without forcing users to set them
- **Conditional requirements**: When a feature is enabled, all its related settings should typically be required — the `enabled` flag acts as the conditional gate
- **Minimal config generation**: Only generate config files (ConfigMaps/Secrets) when a feature requiring them is enabled
- **Derive don't duplicate**: Values that can be derived from existing resources (like URLs from `HttpEndpointInfo`) should be derived, not manually configured
- **Naming**: Settings that map to container environment variables use the exact env var name (e.g. `DNS_SERVER_FORWARDERS` instead of `forwarders`). Exception: settings that are standardized across apps (shared semantics regardless of the app's env var name) use a generic namespace and the component maps them to the app-specific env var — e.g. `auth/clientId`, `auth/clientSecret`, `auth/providerUrl`, `auth/providerName` map to `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OPENID_PROVIDER_URL`, `OAUTH_PROVIDER_NAME` in Open WebUI (and the equivalent vars in other apps). Use this only for genuinely cross-app settings, not for one-off app-specific knobs.

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
