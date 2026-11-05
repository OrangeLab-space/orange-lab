---
name: document-app
description: Use when the user asks to create, update, or revise documentation for an application component — typically an `<app>.md` file under `stacks/<module>/components/<app>/` or `components/<group>/<app>/`. Trigger on phrases like "document `<app>`", "write `<app>`.md", "update `<app>` docs", "add docs for `<app>`", "backfill `<app>` links". The components folder is a Pulumi convention; users think of these as applications, so the skill is named accordingly.
---

# Document Application

Creates or updates the `<app>.md` documentation file for an application component. The skill describes basic rules — a starting point, not a final document. App-specific sections are encouraged when warranted.

## Length and information order

**Aim for 100–150 lines.** Most component docs are read once, by someone trying
to get the thing working — not studied. Treat anything past ~150 lines as a sign
that a section belongs elsewhere (see _Where content belongs_), not as licence to
write more.

**User-facing information goes at the top.** A reader who runs only the first
code block should end up with a working deployment. In practice that means:

- The quick-start / installation block near the top, complete enough to run
- Prerequisites, DNS, and "what else must exist" _before_ or immediately after it
- Background, rationale, history, and edge cases _after_

Readers stop at the first answer. Detail that arrives before the thing they need
is detail they have to skim past.

**Be concise.** Prefer a sentence over a paragraph and a table over prose.
Delete explanation of code that is right there to be read. Do not restate the
config table in prose; do not narrate what a linked document already says.

**Describe what exists, not what was considered.** Design history, rejected
alternatives, and "an earlier version did X" belong in a spec or in commit
messages, not in a document someone reads to use the component. If a decision has
been made and superseded, write the current state and stop.

**Docs describing a current config value go stale the moment that value
changes.** Prefer phrasing that stays true ("add it to X and redeploy") over
asserting that something "is still in place".

## Prose is the failure mode

Component docs grow by appending paragraphs that restate the implementation. Hold
the page to code blocks, bullets and tables:

- A setting belongs in a `pulumi config set` block or a bullet, never in a sentence.
- A sentence earns its place only if it changes what the user does — a caveat, a
  prerequisite, a consequence. How the component works internally belongs in
  `stacks/<module>/spec/<app>.md`.
- If a section needs more than two short paragraphs, convert it to bullets or move
  the detail to the spec and link it.
- Don't narrate internals ("the connector is two artefacts…", "the script installs
  and verifies…") or restate what a command already shows.
- Assume the summary is the only thing many readers read; spend the words there.

## General structure

Use this skeleton, in order. Elements 1–4 are always present; the rest only when
the component needs them.

1. `# <App>` H1 — add `(experimental)` or `(deprecated)` suffix when applicable, matching the module's `README.md` component list
2. Links table — external references, plus the related `stacks/<module>/spec/<app>.md` when one exists
3. Summary — a few lines on what the component is, optionally a short bullet list of capabilities, tools or limits a user needs to know. Assume many readers stop here
4. `## Installation` — one code block with the common working setup (ends at `pulumi up`); mark settings `# (Recommended)` or `# (Optional)` unless most users need them. Put one `cd stacks/<module>` on the first line only
5. (Optional) `## Post-Installation` — manual first-launch steps needed before the app is usable
6. `## Configuration` — settings as code blocks or bullet lists, with one H3 subsection per concern; prose only for a caveat that changes what the user does
7. App-specific H2 sections (integrations, channels, backup, ...), one concern each
8. (Optional) `## Uninstall` (last) — only when `enabled: false` is not enough; list the extra cleanup. Volumes are out of scope

## Links table

Two-column pipe table, no header row. All fields optional, but **Homepage**, **Source code**, and **Documentation** likely exist for most apps. Verify every URL with `webfetch` before writing.

Row order (skip rows that don't apply):

1. **Homepage** — project landing page
2. **Source code** — repository URL
3. **Documentation** — official docs
4. **Configuration** — dedicated config reference page, or source file when no page exists (e.g. ollama's `envconfig/config.go`)
5. **Docker Image** + **Dockerfile** — image-based apps; registry link (usually Docker Hub) for browsing tags, Dockerfile at the upstream source path; name rows when the app ships multiple images (e.g. `Docker backend`)
6. **Helm chart** + **Helm values** — chart-based apps; Artifact Hub page or chart directory + `values.yaml`
7. **Operational notes** — link to `stacks/<module>/spec/<app>.md` when the component has one
8. **Endpoints** (last) — `https://<app>.<domain>/` (hostname from `Pulumi.yaml`, `<domain>` kept as literal placeholder)

Bespoke rows (e.g. `CLI commands`, `Model catalog`) only when warranted.

Example (image-based app):

```
|               |                                                     |
| ------------- | --------------------------------------------------- |
| Homepage      | https://example.com/                                |
| Source code   | https://github.com/org/repo                         |
| Documentation | https://docs.example.com/                           |
| Configuration | https://docs.example.com/env                         |
| Docker Image  | https://hub.docker.com/r/org/image                  |
| Dockerfile    | https://github.com/org/repo/blob/main/Dockerfile    |
| Endpoints     | `https://<app>.<domain>/`                           |
```

When updating the table, backfill missing rows. **Never remove a row without confirming with the user first** — a stale URL may just need an update.

## Installation code block

Single `​`sh`block, ends at`pulumi up`. No `pulumi stack output`line for the endpoint — endpoint retrieval is documented centrally in`docs/configuration.md`.

Match the code-block heading convention used by sibling docs in the same module (the repo is inconsistent: `## Basic configuration`, `## Deployment`, `## Installation`, or no heading). Group under a named H2 only when the block grows beyond ~5 commands.

Use short comments in code blocks to explain non-obvious command groups. Keep the pattern readable: comment, command(s), blank line, next comment. Do not repeat stack-directory `cd` commands in later blocks.

Required and recommended settings go here, not in a later table or section: a reader who stops at the first page should not miss one they need.

Comment prefixes:

- No prefix for required settings
- `# (Recommended)` for settings most users should set
- `# (Optional)` for settings most users can skip

Only include settings the component actually supports. Derive config keys from `<app>.ts` and `Pulumi.yaml` — never guess.

## Post-Installation

Include only if first-launch setup is required. Flat numbered list for simple apps; `### N.` H3 subsections when steps have sub-bullets or multi-line details. Prefix optional user-level steps with `(Optional)` in the heading. Preserve existing steps verbatim when updating.

## Other sections

Add H2 sections when a topic needs more than a code comment — one H2 per concern. Common examples:

- **Prerequisites** — cross-stack or cross-component prerequisites
- **Backup and Restore** / **Encryption Key** / **Admin access** — restore-critical secrets use `config.requireSecret` (must be generated by the user and set before first deploy, e.g. `openssl rand -base64 32` + `pulumi config set --secret` in the deployment block); rotation-safe secrets may stay auto-generated with a retrieve-and-persist flow (`pulumi stack output ... | jq`)
- **Reset Admin Password**, **Upgrade**, **Storage** (`storageOnly`), app-specific integrations
- **Breaking config changes** — add an `Upgrade` section with the exact `pulumi config rm`/replacement commands and the capability loss.
- **Port forwarding** — if the component declares TCP/UDP ports with `public: true`, state the router forward the user must add: `WAN <port> → <node>:<port + 10000>` (see [`docs/public-services.md`](/docs/public-services.md#tcp-and-udp-ports))
- **Uninstall** (last) — only when setting `enabled: false` is not enough: list the extra cleanup, such as removing CRDs, deleting a repository hook, or dropping provider entries. Data volumes are out of scope.

## Relative links

- Same-stack siblings: `../<other>/<other>.md`
- Cross-stack / cross-module (e.g. root-stack operator): `../../../../components/<group>/<app>/<app>.md`

## Verify

Before declaring done:

- Every `pulumi config set <app>:<key>` matches a key in `Pulumi.yaml` or the `.ts` file; every `pulumi stack output ... | jq` path (secrets, not endpoints) matches an `index.ts` export
- Every relative link and referenced helper script resolves (use `glob`)
- Every URL in the links table was verified with `webfetch`
- No `npm test` / `npm run build` — markdown-only change

## Writing principles

- **Derive, don't guess.** Config keys, env vars, output paths, and image names come from `.ts` files, `index.ts`, and `Pulumi.yaml`. Upstream URLs come from `webfetch`.
- **Verify every "requires" and "must" against upstream docs before writing it.** State a requirement only once checked, and say whether it is ours or the upstream project's. Headscale's docs describe local users as the default registration path with OIDC as a delegation option; we had documented OIDC as mandatory.
- **Describe what exists, not what was considered.** No "not served yet", no "future", no notes about unimplemented possibilities or hypothetical endpoints — a reader cannot act on them and they age into lies. If a limitation affects someone using the component today, document it as behaviour.
- **No environment-specific narrative.** Describe the requirement generically ("point the name at your WAN IP, disable your provider's proxying option") and name a vendor only when the vendor's behaviour is the point, such as a DNS-01 provider example. Migration stories from the author's own setup do not belong.
- **Scope "must" to the section it lives in.** In a module doc comparing setups, "must" applies to that option, not to the component — "This option needs both enabled" beats "X and Y must both be enabled".
- **Lead with the TL;DR.** Put the most likely working configuration in the first code block so users can scan the page and deploy without reading every section.
- **Use scannable prose.** Prefer short paragraphs and flat bullet lists over long chains of semicolon-separated clauses.
- **Keep the structure.** Retain useful sections such as Post-Installation, Backup and Restore, and Admin access when they apply.
- **Keep it tight.** Prefer a table, one-line description, short example, and focused sections. Show `pulumi config set ...`, not internal class names. Endpoint goes in the table, not the code block — retrieval is central in `docs/configuration.md`.
- **Document outcomes, not implementation.** Explain what users need to configure and how to reach a working component; omit internal Kubernetes, Helm, Secret, and resource-wiring details unless they affect user action or troubleshooting.
- **Put settings where they will be read.** Required and recommended settings belong in the installation block as `pulumi config set` lines, not in a later "what you need to set" table — most readers stop after the first page and would miss them.
- **Code blocks are for commands.** A block holds real commands with their one-line `#` comments. A block that is only comments is prose — write it as text. An explanatory comment with no command under it goes outside the block as a sentence.
- **Bold UI paths, bullet permissions.** UI navigation such as **Profiles → Create** is bold; permission lists are flat bullets.
- **No implementation rationale.** Say what to set and what the result is, not why an internal mechanism works — users assume the component is configured correctly.
