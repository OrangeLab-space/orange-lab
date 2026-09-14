---
name: update-stacks
description: Use when the user asks to update, deploy, or apply changes to all Pulumi stacks (core and all stacks in the stacks/ folder). Trigger on phrases like "update all stacks", "deploy all stacks", "pulumi up all", or "apply all stacks".
---

# Update Stacks

Updates the core stack and all child stacks in the `stacks/` folder.

## Workflow

### 1. Build the project

Compile shared packages first:

```
npm run build
```

Skip this when the changes are documentation or comment-only (markdown, or a
comment/doc-comment edit) — there is no runtime or infrastructure impact.

### 2. Discover stacks dynamically

- **Core stack**: Look for `Pulumi.<stack>.yaml` in the project root. Use that stack name.
- **Child stacks**: For each subdirectory in `stacks/`, look for `Pulumi.<stack>.yaml`. Collect all stack names. Each child stack must be run from its own directory (`stacks/<name>/`), not the project root.

### 3. Preview all stacks

Skip this entirely when the changes are documentation or comment-only — there is
nothing that can produce an infrastructure diff.

Run previews in parallel where safe:

- Preview the **core** stack first (alone) — run from project root
- Preview all **child stacks** in parallel — each must be run from its `stacks/<name>/` directory

**Core stack:**
```
pulumi preview --json -s <stack-name>
```

**Child stacks (run from `stacks/<name>/`):**
```
pulumi preview --json -s <stack-name>
```

If a stack has no changes, note that. Otherwise, extract from JSON:
- `create`, `update`, `delete`, `replace` counts
- Any policy violations or errors

### 4. Summarize and ask for confirmation once

Present a table:

| Stack | Create | Update | Delete | Replace | Status |
|-------|--------|--------|--------|---------|--------|
| lab (core) | 2 | 5 | 0 | 1 | changes |
| lab-apps | 0 | 0 | 0 | 0 | no changes |
| lab-ai | 1 | 3 | 0 | 0 | changes |

Then ask: **"Apply all stacks?"** (yes/no). Do not proceed without explicit confirmation.

### 5. Update core stack first

Only if core has changes from preview. Run from project root:

```
pulumi up --yes -s <core-stack-name>
```

Wait for completion. If this fails, **stop** and report the error. Do not update child stacks.

### 6. Update child stacks in parallel

Only run on child stacks that have changes from preview. Run them simultaneously from their respective `stacks/<name>/` directories:

```
pulumi up --yes -s <child-stack-name>
```

### 7. Report results

Present a final summary:

| Stack | Result | Notes |
|-------|--------|-------|
| lab (core) | ✅ success | |
| lab-apps | ✅ success | no changes |
| lab-ai | ❌ failed | error message |

For failures, include the last few lines of the error output so the user can diagnose.
