---
name: document-module
description: Use when the user asks to create, update, or revise documentation for a stack module — typically the `README.md` at `stacks/<module>/README.md`. Trigger on phrases like "document `<module>` stack", "update `<module>` README", "write stack README", "add module docs". Distinct from `document-app` (per-component docs); a module README is the entry point that lists and links its components.
---

# Document Module

Creates or updates the `README.md` for a stack module. The README is the stack's entry point: a short description, a linked list of components, and enablement steps for recommended groupings. Keep it a navigational index — details live in each component's `<app>.md`. Deploy/stack-init steps live in `docs/stacks.md`, not here.

## Length and information order

**Aim for 100–150 lines.** A module README is an index and an orientation, not a
manual. If it runs long, the detail belongs in a component's `<app>.md` — link to
it instead of inlining it.

**User-facing information goes at the top.** Someone who reads only the top
should know what the stack is for, what it needs, and how to deploy an app.
Rationale, comparisons, and history come after.

**Be concise, and describe what exists.** A table beats prose, a sentence beats a
paragraph. No design history, no rejected alternatives, no "an earlier version
did X" — a reader cannot act on those and they age into lies. See the
`document-app` skill for the fuller version of these rules.

## General structure

1. `# <Stack> Stack` H1 — module name capitalized (e.g. `Media`, `AI`, `Bitcoin`)
2. One-line description of the stack's purpose
3. `**Prerequisite**: Core stack must be deployed first (...)` — parenthetical names the core-stack capabilities the module depends on (typically `network, storage`; add `, and data operators` when a component needs a core-stack operator, e.g. media needs `cloudnative-pg` for Immich). Don't pad with capabilities the module doesn't use
4. `## Components` — bulleted, linked list with short descriptions
5. (Optional) `## Configure Applications` — `### <App>` subsections enabling recommended components
6. (Optional) `## Migrate from Root Stack` — only for stacks split out from the root stack

## Components

One row per component, linked relatively from the README's directory. No cross-stack links in a stack README — cross-stack references belong in component docs or the root `README.md`.

```
- [<App>](./components/<app>/<app>.md) — <short description>
```

- Separator is `—` (em dash); description is one phrase, no trailing period
- Suffix `(experimental)` or `(deprecated)` when the component doc's H1 carries it — keep the list in sync with the component docs
- Order: recommended/primary first, then secondary, then `(experimental)` and `(deprecated)` last
- Every component imported by `stacks/<module>/index.ts` should have a row. If `index.ts` imports a component with no doc, surface it — don't add a row pointing at a missing file

Optional or uncommon components appear **only** in this list — they are not repeated in `## Configure Applications`.

## Configure Applications

Include only when the stack has components that need explicit enablement. One `### <App>` H3 per component, or `### <App> + <App>` for coupled groups (e.g. `### DroppedNeedle + slskd - Music`); `####` sub-subsections are fine when a group splits into independent enablement blocks.

Each subsection is a single `sh` block ending with `pulumi up`:

```
pulumi config set <app>:enabled true
# (Recommended) <key> <value>
# (Optional) <key> <value>
pulumi up
```

Comment prefixes match `document-app`: no prefix for required, `# (Recommended)` for most users, `# (Optional)` for skippable. Derive config keys from the component's `<app>.ts` and the stack's `Pulumi.yaml` — never guess.

## Migrate from Root Stack

Include only when the stack was split out from the root stack (e.g. `ai`, `bitcoin`). Two-part prose + two `sh` blocks:

1. Explain: plain values copy across `Pulumi.<stack>.yaml`; secrets need re-encryption because stack keys differ
2. First block runs in the root stack: `pulumi config get --secret <key>` for each secret, with a comment listing the component groups (e.g. `# copy all settings from: ollama,open-webui,...`)
3. Second block runs in the new stack: `pulumi config set --secret <key> <value>` for each

## Verify

Before declaring done:

- Every component link resolves (use `glob`) and every component imported by `index.ts` has a row
- `(experimental)` / `(deprecated)` suffixes match each component doc's H1; prerequisite parenthetical matches the module's actual dependencies
- Every `pulumi config set <app>:<key>` in `## Configure Applications` matches a key in `Pulumi.yaml` or the component's `.ts` file
- No `npm test` / `npm run build` — markdown-only change

## Writing principles

- **Index, not manual.** The README points to component docs; it doesn't restate them. If a topic needs more than a one-line description, it belongs in the component's `<app>.md`.
- **Derive, don't guess.** Component list comes from `index.ts` imports; config keys from `Pulumi.yaml` and `.ts` files; descriptions from the component docs' one-line summary.
- **Keep it tight.** `## Configure Applications` is for recommended groupings only. A stack whose components need nothing beyond `pulumi config set <app>:enabled true` (e.g. `dev`) doesn't need the section at all — that one line can live in the list description instead.
