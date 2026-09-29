---
name: create-release
description: Use ONLY when the user asks to create a new release, draft release, or release notes for the orange-lab project. Trigger on phrases like "create release", "draft release notes", or "release 0.6.0".
---

# Create Release

Creates a GitHub draft release with categorized release notes for the orange-lab project.

## Workflow

### 1. Determine version

- If the user provided a version (e.g., "create release 0.6.0"), use that.
- Otherwise, inspect commits since the last release and suggest a version:
  - Breaking change or new feature → bump minor (`0.x.0`)
  - Fixes only → bump patch (`0.0.x`)
- Ask the user to confirm or override the version before proceeding.

### 2. Find the latest release tag

```
gh release list --repo OrangeLab-space/orange-lab --limit 1 --json tagName
```

### 3. Collect commits since the last tag

```
git log <latest-tag>..HEAD --oneline
```

### 4. Study previous release format

Read the previous release notes to match the established structure and tone:

```
gh release view <latest-tag> --repo OrangeLab-space/orange-lab
```

### 5. Categorize and draft release notes

Match the section structure used in previous releases (see v0.5.0/v0.6.0). Top-to-bottom order:

1. **`# Applications`** — New apps or modules. Link to the component doc and use a sublist when one module adds multiple apps. Order by importance to the user (most impactful first).
2. **`# Features`** — New user-facing capabilities, settings, and improvements. Combines `feat:` commits with user-visible `perf:`/`refactor:`/`chore:`/`docs:`/`build:` changes. Focus on what the user can now do or what behavior changed for the better.
3. **`# Fixes`** *(optional)* — `fix:` commits for apps that existed in the previous release. Only include fixes significant enough that an upgrader would recognize the symptom. Omit the section entirely when no fix clears that bar.
4. **`# ⚠️ BREAKING CHANGES & UPGRADE ACTIONS`** — `!:` or commits with `BREAKING CHANGE:`. Numbered `###` subsections, each with `- **Action**:` items.

#### Writing principles

- **User, not contributor.** Write for someone upgrading from the previous tag. They need to know: what new apps they can enable, what settings to add/change, and what breaking actions to take. Never mention internal APIs, class names, or function names — show the Pulumi config setting instead (e.g., `<app>:gpu`, not `Nodes.getGpu()`).
- **Keep it short.** Readers skim. Cut anything too detailed, too vague, or minor. When in doubt, leave it out. Examples of what to cut: internal config options (secrets-as-volumes, postgres extensions), minor fixes (permissions, timeouts), script lists, hardware-specific detection details, external traffic policy, "improved X support" without a concrete setting.
- **No app version numbers.** Every release uses the latest published images. Don't mention specific app/chart versions unless it's a pinned-version behavior change the user must know.
- **No fixes for newly-added modules.** If an app was added this release, don't list its fixes — the upgrader never saw the bug. They just need to know the app exists.
- **Order by user importance.** Put the most impactful items first within each section.
- **Scope claims correctly.** Only state scope you've verified (e.g., "Helm charts pinned in core stack", not all stacks).

#### Breaking change criteria — be strict

A breaking change must require user action to migrate. Filter out:

- **Dangerous advice** — never suggest `pulumi destroy` on the core stack.
- **Internal-only changes** — build system moves, internal code refactors not visible in `Pulumi.yaml` (e.g., `overrideFullname` hack removal). Document build steps in `AGENTS.md`/docs, not as a user breaking change.
- **Same-cycle break/fix pairs** — if something broke and was fixed within this release cycle, the upgrader never sees it. Skip it.
- **Contributor-facing changes** — anything that only affects someone editing `packages/pulumi`.

For each valid breaking change:
- Add a `- **Action**:` line describing what the user must do.
- Include runnable `sh` commands when the action is concrete (e.g., `pulumi config set ...`).
- Link to relevant docs (e.g., `docs/stacks.md`) for multi-step migrations.
- Group apps that just need disable/re-enable into a single numbered section with a shared command block.

#### Casing

Only the **MEDIA** stack name is uppercase in the Applications section. All other app/module names use natural casing (e.g., Vaultwarden, Technitium, RustFS, Nextcloud).

#### Doc links

Link each new app/module to its component Markdown file relative to repo root (e.g., `stacks/media/README.md`, `components/storage/rustfs/rustfs.md`). Verify the path exists with a glob before linking.

### 6. Present the draft to the user

Show the generated markdown release notes and ask for confirmation, edits, or cancellation. Iterate on feedback — the user will often request cuts, reordering, or corrections. Do not create the release until the user approves.

### 7. Create the draft release

Write the final notes to a temp file and pass it via `--notes-file` (avoids shell-escaping issues with multi-line markdown):

```
gh release create <version> --draft --repo OrangeLab-space/orange-lab --title "<version>" --notes-file /tmp/opencode/release-notes-<version>.md
```

- Publish **only as a draft** so the user can refine in the GitHub UI.
- After creation, report the draft release URL to the user.
