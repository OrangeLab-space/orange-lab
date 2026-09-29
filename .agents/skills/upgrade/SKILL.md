---
name: upgrade
description: Use ONLY when the user asks to upgrade the OrangeLab installation to a newer version or release. Trigger on phrases like "upgrade orangelab", "update orange-lab to the latest release". Not for npm dependency updates (use update-npm) or deploying local changes (use update-stacks).
---

# OrangeLab Upgrade

## Mode of Operation

You are operating in **PLAN MODE as a guide**. You will:

- **ANALYZE** the current state using read-only commands
- **EXPLAIN** each step clearly so the user understands what needs to be done
- **SHOW** the exact commands the user should run
- **VERIFY** the user completed each step correctly before proceeding

**You must NEVER:**

- Execute commands that modify state (`pulumi up`, `pulumi config set`, `git pull`, etc.)
- Use `--show-secrets` flag - secrets must not be sent to external models
- Make any changes to files or infrastructure directly
- Skip ahead or preview future steps

**After each step**: STOP, show analysis, and ask user "Continue to Step X?"

## How User Runs Commands

The user can run commands in two ways:

1. **Separate terminal** - Copy-paste commands to their own terminal window
2. **OpenCode shell** - Prefix with `!` to run in OpenCode (e.g., `!npm install`) - you will see the output

When showing commands for the user to run, format them clearly:

```
👉 Run in your terminal (or use !command in OpenCode):
   <command>
```

## Context

- **Current version**: Read from `package.json` (version field)
- **GitHub releases**: https://github.com/OrangeLab-space/orange-lab/releases
- **Repository**: OrangeLab-space/orange-lab
- **Upgrade docs**: `docs/upgrade.md` - standard upgrade procedures
- **Storage docs**: `docs/configuration.md` - volume management and `fromVolume` usage
- **Multi-stack docs**: `docs/stacks.md` - module stacks and their dependencies on core

## Multi-Stack Layout

OrangeLab deploys as multiple independent Pulumi stacks (see `docs/stacks.md`):

- **Core stack**: repository root - installs CRDs, storage classes, and ingress controllers that all module stacks depend on. Must be upgraded/deployed FIRST.
- **Module stacks**: `stacks/<module>/` - independent stacks (`apps`, `ai`, `bitcoin`, `dev`, `iot`, `media`). Each has its own config; an app's `<app>:enabled` setting lives in the stack where the app is deployed.

All upgrade commands (`pulumi preview`, `pulumi up`, `pulumi config`) must run in the correct stack directory - use `--cwd <dir>` or instruct the user to `cd`. Always order operations core-first.

## Overview

This skill guides users through upgrading their OrangeLab installation safely.

**Quick Upgrade** (no breaking changes):

- Step 0: Check for uncommitted changes and pending infrastructure updates (all stacks)
- Step 1: Analyze incoming changes, if no breaking changes → `git pull --rebase && pulumi up` (core first, then module stacks)

**Full Upgrade** (breaking changes detected):

- Steps 2-11 (in `full-upgrade.md`): Verify storage safety, save secrets, update K3s, disable/re-enable affected apps

## Important Rules

- Before each step: Explain what will be done so the user understands the process
- After each step: Ask the user to confirm completion, then verify everything is correct
- Ask for confirmation before proceeding to the next step
- If issues occur: Summarize them, suggest potential resolutions, and ask for direction
- Never proceed automatically if errors are detected
- **NEVER use `--show-secrets`** - this would expose secrets to external models
- If issues occur during any step, use the Troubleshooting section at the bottom of `full-upgrade.md`

## Steps

### Step 0: Preparation (Start Here)

**Tell user**: "First, I'll check your current state and see if there are any pending infrastructure changes before we pull new code."

**Run these commands**:

```bash
# Check for uncommitted changes
git status

# Check current infrastructure state (core stack)
pulumi preview --diff

# Detect initialized module stacks
for d in stacks/*/; do
  echo "=== $d ==="
  pulumi stack ls --cwd "$d" 2>/dev/null | tail -n +2
done

# Preview each initialized module stack (repeat for each stack listed above)
pulumi preview --diff --cwd stacks/<module>
```

**If git status shows uncommitted changes**:

- **Ask user**: "You have uncommitted changes. Do you want to: (a) stash them, (b) commit them, or (c) abort upgrade?"
- Wait for user to resolve before continuing

**If any stack preview shows changes**:

- **Tell user**: "There are pending infrastructure changes (likely version updates or config drift). It's best to apply these before pulling new code."
- **Show user** (core first, then module stacks):

    ```
    👉 Run in your terminal (or use !command in OpenCode):

       # Core stack first (installs CRDs/storage/ingress that modules depend on)
       pulumi up

       # Then each module stack with pending changes
       pulumi --cwd stacks/<module> up
    ```

- Wait for user to confirm changes are applied
- Run the previews again to verify clean state

**When git is clean and all stack previews are clean**, proceed to Step 1.

---

### Step 1: Analyze Incoming Changes

**Tell user**: "I'll check for incoming changes and identify any breaking changes that require special handling."

**Run these read-only commands**:

```bash
# Get current version
cat package.json | grep '"version"'

# Fetch latest from GitHub
git fetch origin

# Check for incoming changes (overview)
git log HEAD..origin/main --oneline

# Get full commit messages to find BREAKING CHANGE entries
git log HEAD..origin/main
```

**To check for major releases** (try `gh` first, fall back to WebFetch):

```bash
# Try gh first (saves tokens)
gh release list --repo OrangeLab-space/orange-lab --limit 5
```

If `gh` is not configured, use WebFetch: `https://github.com/OrangeLab-space/orange-lab/releases`

**Analyze the output for USER-FACING breaking changes**:

A breaking change is ONLY something that requires the user to modify their `pulumi config`. Look for:

- Commits containing "BREAKING CHANGE:" in their body - these contain migration instructions
- Release notes sections titled "BREAKING CHANGES" or "UPGRADE ACTIONS"
- Config key renames (e.g., `app:oldKey` → `app:newKey`)
- Removed config options that the user may have set
- New required config options

**NOT breaking changes** (ignore these):

- Internal code refactoring (changing how code is structured internally)
- Dependency updates
- Moving config access from one internal pattern to another
- Any change that doesn't require user action in `pulumi config`

**Example**: A commit saying "refactor: config now uses `config.require()` directly" is internal code cleanup, NOT a breaking change. The user's config file is unchanged.

**If user-facing breaking changes found**, check which apps are affected by reading the config of each deployed stack (core first, then module stacks):

```bash
# Core stack config
pulumi config

# Module stack configs (repeat for each initialized stack from Step 0)
pulumi --cwd stacks/<module> config
```

Cross-reference breaking changes with enabled apps. An app is only affected if it is enabled (`<app>:enabled true`) in one of the deployed stacks - note WHICH stack each affected app lives in, later steps need this. If all affected apps are disabled (`enabled: false` or not configured), they don't require the full upgrade path.

**NEVER disable these components** (apply config migrations directly instead):

- **Longhorn** - Storage backend; disabling could remove storage volumes
- **cert-manager** - Stores certificates in CRDs; disabling would lose certs

Other infrastructure (Traefik, Tailscale) can be safely disabled and re-enabled.

---

### If NO breaking changes found (or only affect disabled apps) → Quick Upgrade Path

**Tell user**: "No breaking changes affect your enabled apps. We can do a simple upgrade."

**Show user commands**:

```
👉 Run in your terminal (or use !command in OpenCode):

   git pull --rebase origin main
   npm install
   npm test
```

**After user completes**, run previews for all stacks (core first, then each initialized module stack from Step 0):

```bash
pulumi preview --diff
pulumi preview --diff --cwd stacks/<module>
```

**Analyze previews for safety**:

- Look for unexpected resource REPLACEMENTS or DELETIONS
- Minor updates (image versions, config changes) are expected and safe

**If previews look safe**, show user the apply commands (core first - module stacks depend on core CRDs/storage/ingress):

```
👉 Run in your terminal (or use !command in OpenCode):

   # Core stack first
   pulumi up

   # Then each module stack
   pulumi --cwd stacks/<module> up
```

**After user applies**, verify:

```bash
kubectl get pods -A | grep -v Running | grep -v Completed
```

**If all pods healthy**, report success and END upgrade process.

**If previews show concerning changes** (major replacements, deletions), continue to Step 2 in `full-upgrade.md` for detailed analysis.

---

### If breaking changes affect ENABLED apps → Full Upgrade Path (Steps 2-11)

**Tell user**: "Breaking changes detected for enabled apps. We'll need to follow the full upgrade process to safely migrate."

**Report to user**:

```
Current version: [version from package.json]
Latest release: [version from GitHub]
Incoming commits: [count]

Breaking changes found:
- [list BREAKING CHANGE entries from git log, include full instructions]

Apps requiring action:
- [list apps that need disabling/config changes, with the stack each lives in]
```

**Ask user**: "Continue to Step 2: Verify Storage Safety?"

If the user confirms, load `full-upgrade.md` from this skill's directory (`.agents/skills/upgrade/full-upgrade.md`) and follow Steps 2 through 11.
