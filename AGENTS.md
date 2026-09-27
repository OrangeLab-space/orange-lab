# OrangeLab Guidelines

## Commands

- Confirm with the user before running any command that changes the state of the cluster (e.g. `pulumi up`, `kubectl apply/delete`, `helm install/upgrade`, `kubectl rollout restart`). Read-only analysis commands (`kubectl get`, `pulumi preview`, `logs`, `describe`) do not need explicit approval.
- Deployment: `pulumi up --yes` (only with user approval)
- Preview changes: `pulumi preview --diff` (useful for checking for any unintended changes after major code updates or refactoring)
- Build/Test/TypeCheck (TypeScript only): `npm test`
    - ⚠️ SKIP for markdown/documentation changes - no need to run
- Build `@orangelab/pulumi` after editing `packages/pulumi/src/`: `npm run build` (must be run before `pulumi up` or `pulumi preview`)

## Architectural Principles

- **Simplicity Over Complexity (KISS):** Prioritize simple, straightforward solutions. Avoid over-engineering or introducing complex patterns without consultation.
- **You aren't gonna need it (YAGNI):** Only implement features and functionality that are required now. Avoid building for hypothetical future scenarios.
- **Loose Coupling:** Strive to keep components independent. Avoid creating circular dependencies.
- **Single Responsibility:** Each class has one clear purpose: Metadata for labels/annotations, Network for ingress/services, Storage for volumes, etc. Extract functionality into separate files/classes when components have distinct responsibilities, even if they seem related (e.g., init containers handle volume preparation while runtime containers handle main workloads with GPU support).
- **Encapsulation of Complexity:** Complex logic should be encapsulated within classes. Expose clean interfaces rather than leaking implementation details.

## Commit Messages

- Use conventional commits: `scope:` or `fix(scope):` for normal changes and bug fixes, `scope!: BREAKING CHANGE` for breaking changes
- One line is usually sufficient; add detailed description only for breaking changes explaining how to migrate
- Include why the change matters (e.g., "shows up in Headlamp in Cluster/Nodes")
- Don't use "refactor:" for breaking changes

## Working Conventions

### Workflow Phases

Follow these phases in order. Do NOT skip to implementation without completing the earlier phases. Implementation is the LAST step.

1. **Understand**: Gather key symptoms and surface possible investigation tracks early, so the user can add context, reject dead ends, or suggest simpler fixes (e.g., "just restart the service"). Only dive deep into logs/code paths when the quick assessment reveals no obvious fix or the user confirms the direction. If deep investigation isn't converging, stop and discuss findings so far.
2. **Discuss**: Present findings and potential solutions with trade-offs. Ask the user to choose direction when multiple paths exist. Do not implement yet.
3. **Plan**: Once direction is agreed, present a concrete implementation plan (files to change, what changes, verification steps). Get explicit confirmation before proceeding.
4. **Implement**: Only after the plan is confirmed, make the changes. Run build/test/typecheck. Report results.
5. **Verify**: Confirm the changes work (preview, deploy, test). Report results and stop — let the user decide next steps.

Stay within the requested scope. When you notice out-of-sync or broken things outside it, surface them as a list — don't silently fix them.

### Switching Back to Discussion Mode

During implementation, stop and switch back to discussion mode when:

1. **Library change may be needed**: If the implementation would require manual Kubernetes manifests or workarounds for something the library (`@orangelab/pulumi`) should handle, stop. Propose the library change instead so other components can reuse it.
2. **Scope changes or faulty assumptions surface**: If something unexpected comes up (a conflict, a wrong assumption, a side effect), stop. Agree on a path forward before continuing — the user may want to defer the fix to a separate task.
3. **New coupling or assumption**: If the change would introduce a new cross-dependency or assumption (e.g. a shared tool reading app-specific config, one module reaching into another's state), stop and propose it. Don't add couplings silently — they have consequences and need to be discussed.

### Asking for Confirmation

Stop and ask when you encounter:

- **Comments indicating multiple values**: e.g., `// info, debug, dev` suggests more complexity than a boolean
- **Inconsistent patterns**: same concept handled differently in different files
- **Configuration that maps to multiple levels**: debug might be true/false in one place but have granular levels elsewhere
- **Deprecation markers**: comments about future changes or TODOs
- **Type mismatches**: a value used as boolean in one place but string/enum in another
- **Defaults from a single use case**: a hardcoded value that matched the original caller (e.g., a port) may not be a sensible library default — make app-specific values required parameters

Even if the change seems straightforward, these signals may indicate the current pattern is intentionally simplified (YAGNI) or needs expansion.

## Conventions

- **Pulumi stack files**: Never modify or read `Pulumi.*.yaml` files directly — they may contain secrets. Use `pulumi config set <key> <value>` / `pulumi config get <key>` (`--secret` for sensitive values). If a change to these files is needed, give the user the commands to run.
- **Secrets stay local**: Prefer `pulumi config` (run in the stack folder) or `pulumi config --cwd <stack> --stack <name>` to read config. Avoid `--show-secrets` unless a secret value is genuinely required for the task — when it is, give the user the command to run themselves so the plaintext never traverses the session/channel. Reading non-secret config values (paths, sizes, flags) is fine via the agent.
- **Applications** use the Application class for Kubernetes resources (including namespaces and storage for Helm charts).
- **Writing TypeScript** (components, stacks, `@orangelab/pulumi` library): follow the `code-conventions` skill.
- **Writing docs** (component `<app>.md`, stack `README.md`): follow the `document-app` / `document-module` skills.
