---
name: code-review
description: Use when the user asks to review code changes in the orange-lab repo — staged/local changes or a GitHub pull request. Trigger on phrases like "review my staged changes", "code review", "review before commit", "review PR #6", "review the open PRs".
---

Review code changes for quality, security, adherence to OrangeLab conventions, and
blast radius — what merging/pulling the change would actually affect.

## Steps

### 1. Get the changes

- **Named PR**: `gh pr view <n> --json number,title,body,author,baseRefName,mergeable,mergeStateStatus,files,additions,deletions`
  and `gh pr diff <n>` — read the full diff, not just the summary. Also
  `gh pr checks <n>` and `gh pr view <n> --comments` for review state/discussion.
- **Staged changes**: `git diff --cached`.
- **If no staged changes**: look at modified files (`git status --short`, `git diff`)
  and ask the user whether to review those instead. Do not proceed without confirmation.
- Identify scope and type: `packages/pulumi/src/` (library), `stacks/<module>/` or
  `components/` (one stack), `scripts/` (tooling), docs (markdown only).

### 2. Understand the change

- Read the surrounding code, not just the diff hunk. What does it interact with?
- For a PR, **do not trust the description's root cause.** Confirm it by reading the
  actual code path and the relevant upstream docs/source (Kubernetes API semantics,
  operator webhooks, chart docs). Check whether the commit message is accurate.

### 3. Review for OrangeLab Principles

- **Simplicity (KISS/YAGNI)**: Does the solution avoid over-engineering? Is it only implementing what's needed now?
- **Loose Coupling**: Are components independent? Any new circular dependencies?
- **Single Responsibility**: Do classes follow the established patterns (Metadata for labels, Network for ingress, etc.)?

### 4. Technical Review

- **TypeScript**: Strict type checking enforced? Any `any` types that should be replaced?
- **Infrastructure (Pulumi)**: Are new resources using the `Application` class? Are names and tags (like `tag:orangelab` for Tailscale) consistent?
- **Security**: Sensitive data handled via `envSecret` in `ContainerSpec`? No hardcoded secrets or passwords in command args?
- **Style**: camelCase for variables/functions, PascalCase for types/classes?

### 5. Blast Radius

Answer concretely: *if this is merged and pulled here, what actually changes?*

**a. Source scope** — `packages/pulumi/src/` is the `@orangelab/pulumi` library → every
stack imports it (npm workspace, symlinked; `main` points at `dist/`). `stacks/<module>/`
and `components/` affect only that module/stack. `scripts/` and docs affect tooling/docs only.

**b. Reachability** — which code actually runs the changed line? Grep for callers and
the config gates that enable the path (e.g. `rg -n "<symbol>" --glob '!node_modules' --glob '!dist'`).
Query live config to see which apps/stacks are affected (non-secret values only):
`pulumi config --cwd stacks/<module> --stack <name>`. State which components are affected
and which are not.

**c. Rebuild & preview impact** — a library change is invisible to `pulumi up`/`preview`
until `npm run build`. What would `pulumi preview --diff` show: which resources
create/update/delete, which are untouched? (Prefer running it read-only; get approval
before `up`.)

**d. Retroactivity & live verification** — does it affect only *future* resource
creation or *existing* deployed resources? Check immutability rules (e.g. PVC
`dataSource` is immutable and invalid values are silently dropped; CNPG only rejects
storage *shrink*). Verify assumptions against the live cluster with read-only `kubectl`,
because intent and the object actually created can differ: the object's real spec/name,
whether a pre-created or operator-created resource wins, implicit Pulumi dependency
ordering (an `Output`-derived arg forces the referenced resource to be created first),
and name collisions. ⚠️ A change can be technically correct yet a **no-op** if the code
path is dead, self-referential, or the target object is created elsewhere.

**e. Rollback cost** — reversible with a one-line config/spec revert, or does it require
deleting resources / restoring data? Does it drop or migrate data?

Never read `Pulumi.*.yaml` directly (secrets); use `pulumi config`.

### 6. Verification

- **Linting/Tests**: Run `npm test` to ensure code matches project standards. Skip for
  markdown-only changes (per AGENTS.md).
- **Infrastructure Preview**: Run `pulumi preview --diff` to verify intended infrastructure changes.

## Important Rules

✅ Use conventional commits (`scope:` or `fix(scope):`)
✅ Prefer composition over inheritance
✅ Pass dependencies through args (providers, config, metadata)
✅ `config` can be used to read common configuration settings
✅ Use `Application` class for K8s resources
❌ Don't use "refactor:" for breaking changes
❌ Don't expose passwords in command line arguments
❌ Avoid `any` type

## Expected Output

### Summary

Brief overview of the changes and alignment with OrangeLab principles.

### Blast Radius

- Source scope (library / module / script / docs)
- Which components/stacks/config keys actually reach the change
- What `pulumi preview` would show after pull + build (or "no diff")
- Retroactive effect on existing deployments vs new only
- Live evidence checked (kubectl / config), and rollback cost

### 🔴 Critical Issues

- Security risks (exposed secrets, missing `envSecret`)
- Breaking changes labeled incorrectly
- Violation of Single Responsibility or KISS principles
- Linting/Type errors

### 🟡 Important Suggestions

- Code quality improvements (naming, structure)
- Optimization of Pulumi resources
- Missing test coverage
- Improperly tagged resources

### 🟢 Nice to Have

- Minor refactoring for better readability
- Documentation enhancements

### ✅ Good Practices Observed

- Proper use of `Application` class
- Clean TypeScript patterns
- Well-structured Pulumi resources

## Recommendations

- Approval status (Merge / Request Changes / Needs Discussion)
- Required fixes before merge
- If a fix is a no-op or masks a deeper design issue (dead code, redundant resource),
  say so and propose the real fix instead of merging blindly
- Suggested commit message following conventional commits
