---
name: upgrade-versions
description: Use when the user asks to find, check, or bump container images, Helm chart versions, or release versions across the repository. Trigger on phrases like "upgrade versions", "bump images", "check for latest images", "update helm chart versions", or "check outdated images and charts". Not for npm dependencies (use update-npm) or git pulling a new OrangeLab release (use upgrade).
---

# Upgrade Versions (Images & Helm Charts)

Hunts down the latest upstream container image tags, Helm chart versions, and component release versions across the repository, presents a categorized table of available updates, asks the user which ones to upgrade, and updates the defaults in `Pulumi.yaml` files and component documentation.

## Security & Operational Rules

- **Never read or modify `Pulumi.<stack>.yaml` files directly**: Only inspect and edit stack definition defaults (`Pulumi.yaml`, `stacks/*/Pulumi.yaml`), component code (`components/**/*.ts`, `stacks/*/components/**/*.ts`), and documentation (`*.md`). Use `pulumi config --cwd <dir>` to read active stack configuration with secrets redacted (never pass `--show-secrets` or run `pulumi config get` on secret keys).
- **Report every candidate; don't pre-filter**: Discover all pinned versions and present every available update, including ones that look intentionally pinned. There is no list of components to skip — surface what is outdated and let the user decide.
- **Floating tags**: tags like `:latest`, `:stable`, `:main-slim`, `:full`, `:base`, or major-only pins like `redis:8-alpine`, `eclipse-mosquitto:2` rarely need a bump; report them and expect to leave them as-is unless the user asks.
- **Digest-pinned images** (`image:tag@sha256:...`) require resolving both the new upstream tag and its multi-arch manifest `sha256` digest when updating.
- **Paired versions**: some components ship two images, or a version plus a sidecar image, that must move together — for example an app image paired with its machine-learning image, or a chart version paired with its metrics-exporter image. Check and update them in lockstep and note the pairing.

---

## Workflow

### 1. Discover Pinned Versions in the Repository

Scan the repository for all pinned versions across stack configs and component definitions:

1. **Stack `Pulumi.yaml` files and active stack config**:
   - Inspect `Pulumi.yaml` and `stacks/*/Pulumi.yaml` defaults, and run `pulumi config --cwd <dir>` on initialized stacks to read all active values (including stack-level overrides) with secrets redacted:
   - Container images (`<app>:image`, `<app>:<subcomponent>/image`) with explicit version tags.
   - Helm chart versions (`<app>:version`).
   - Integration / CRD URLs and tags (e.g. `<app>:gatewayApiCrdUrl`, `<app>:oidcVersion`, `<app>:frigateVersion`).
2. **Component TypeScript files** (`components/**/*.ts`, `stacks/*/components/**/*.ts`):
   - `addHelmChart` calls (`repo` and `chart`). Note which charts have a `<app>:version` pinned in `Pulumi.yaml` vs. which ones are unpinned (floating to latest chart on install/upgrade).
   - Hardcoded plugin or sidecar versions in code (e.g. `traefik-oidc-auth` plugin `version` in `components/network/traefik/traefik.ts`).

### 2. Query Upstream for Latest Stable Releases

Check upstream sources in parallel (using `gh release list` / `gh api`, `helm search repo`, or `curl` / `webfetch` against GitHub Releases, Helm `index.yaml`, or Docker Hub / GHCR tags):

- **GitHub-hosted projects & images**:
  - Prefer `gh api repos/<owner>/<repo>/releases/latest --jq .tag_name` (or `gh release list --repo <owner>/<repo> --limit 5` to skip pre-releases/betas).
  - Match the tag prefix convention used in `Pulumi.yaml` (e.g. preserve `v` prefix if the current tag uses `v`, strip it if the image tag omits `v` like `ghcr.io/tale/headplane:0.8.0` or `longhorn:version: 1.13.0`).
- **Docker Hub images** (when the tag format differs from the GitHub release, or there is no GitHub release):
  - Query Docker Hub API: `curl -s "https://hub.docker.com/v2/repositories/<namespace>/<repo>/tags?page_size=25"`.
- **Helm Charts**:
  - Fetch the chart repository's `index.yaml` or GitHub releases for charts pinned with `<app>:version` in `Pulumi.yaml`:
    - `longhorn` (`https://charts.longhorn.io/index.yaml`)
    - `nvidia-gpu-operator` (`https://helm.ngc.nvidia.com/nvidia/index.yaml`)
    - `amd-gpu-operator` (`https://rocm.github.io/gpu-operator/index.yaml`)
    - `cloudnative-pg` (`https://cloudnative-pg.github.io/charts/index.yaml`)
  - If the user also wants to check unpinned Helm charts (charts without `<app>:version` in `Pulumi.yaml`, such as `traefik`, `cert-manager`, `tailscale-operator`, `kube-prometheus-stack`, `mariadb-operator`, `node-feature-discovery`, `nextcloud`, `vaultwarden`, `forgejo`, `home-assistant`, `ollama`, `kubeai`), check whether any deployed stack has an outdated release using `helm list -A` and compare against upstream chart `index.yaml`.
- **Ignore pre-releases**: Filter out `-alpha`, `-beta`, `-rc`, `-dev`, and nightly tags unless the current version is already tracking a pre-release.

### 3. Present Findings & Ask the User Which to Upgrade

Group the outdated or overridden items clearly and present a summary table showing the `Pulumi.yaml` default, any active stack override from `pulumi config`, and the latest upstream version:

| Component | Stack / File | Key | Default (`Pulumi.yaml`) | Current (Override) | Latest | Update Type | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `pocket` | `Pulumi.yaml` (core) | `pocket:image` | `v2.18.0` | — | `v2.19.0` | Minor | |
| `longhorn` | `Pulumi.yaml` (core) | `longhorn:version` | `1.13.0` | `1.12.2` | `1.14.0` | Minor | Check upgrade path |

Include:
- **Default (`Pulumi.yaml`)**: The default version defined in `Pulumi.yaml` / `stacks/*/Pulumi.yaml` (or hardcoded in `.ts`).
- **Current (Override)**: The active stack's value from `pulumi config --cwd <dir>` if it overrides the default, or `—` when using the default. Include rows where a stack override differs from the default even if `Pulumi.yaml` is already on the latest version.
- **Latest**: The newest stable upstream version found.
- **Update Type**: `Patch`, `Minor`, or `Major`
- **Breaking change / compatibility notes**: Briefly flag major version jumps, database image upgrades (like `cloudnative-vectorchord`), or coupled requirements (e.g. Headplane requiring a minimum Headscale version, Longhorn multi-step minor version rules).
- **Up-to-date items**: Briefly list or count components that are already on the latest version (with no stack override drift) so the user knows they were checked.

Use the `question` tool (with `multiple: true`) or ask the user directly **which components they want to upgrade** (e.g. individual components, all patch/minor updates, or all updates). Do **not** edit files until the user selects which ones to upgrade.

### 4. Apply Selected Version Bumps

For each component the user selected:

1. **Update `Pulumi.yaml` / `stacks/<module>/Pulumi.yaml`**:
   - Update the version tag and any paired key (e.g. a machine-learning image alongside its app image) together.
   - If the image uses a `@sha256:...` digest, fetch the current multi-arch manifest digest for the new tag and update both tag and digest.
2. **Update Component Documentation (`*.md`)**:
   - Grep for the old version string across `components/` and `stacks/` (e.g. default version tables in `<app>.md`) and update any matching references so docs stay in sync with `Pulumi.yaml`.
3. **Handle Active Stack Overrides**:
   - If the selected component had a `Current (Override)` value in the active stack config, remind the user that updating `Pulumi.yaml` won't take effect until the override is removed or updated, and show them `pulumi config delete <key>` (to fall back to the new default) or `pulumi config set <key> <new-value>`.
4. **Build & Test (if any `.ts` files were modified)**:
   - Run `npm test` if any TypeScript file was changed (skip for `Pulumi.yaml` and `.md`-only changes).

### 5. Preview & Offer Deployment

1. Run `pulumi preview --diff` on the affected stack(s) to verify the version bump produces only the expected image/chart diff.
2. Report the updated files and preview summary, and stop — let the user decide whether to deploy with `pulumi up` (or the `update-stacks` skill).
