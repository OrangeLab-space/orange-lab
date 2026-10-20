# OrangeLab Guidelines

## Commands

- Confirm with the user before running any command that changes the state of the cluster (e.g. `pulumi up`, `kubectl apply/delete`, `helm install/upgrade`, `kubectl rollout restart`). Read-only analysis commands (`kubectl get`, `pulumi preview`, `logs`, `describe`) do not need explicit approval.
- Deployment: `pulumi up --yes` (only with user approval)
- **Recovery from state/cluster divergence**: refresh and re-sync, do not debug individual resources. Run `pulumi refresh --yes` then `pulumi up --yes -r` (replace). Use `-r` freely — the stack should always be reconciled with the manifests, and infra is disposable. Do NOT hand-delete individual resources or try to adopt orphans one at a time; that leaves pending operations in state and costs more attempts than a single replace resolves. Note `pulumi refresh` needs to run interactively to clear a pending CREATE.
- Preview changes: `pulumi preview --diff` (useful for checking for any unintended changes after major code updates or refactoring)
- Build/Test/TypeCheck (TypeScript only): `npm test`
    - ⚠️ SKIP for markdown/documentation changes - no need to run
- Build `@orangelab/pulumi` after editing `packages/pulumi/src/`: `npm run build` (must be run before `pulumi up` or `pulumi preview`)
- Never kill a running `pulumi up` to "unstick" it — it leaves pending operations and orphaned resources. Let it finish or fail on its own.
- **Recovery from a killed `pulumi up`**: an update interrupted from the outside (rather than one that failed) leaves the stack showing an active update while its state has no pending operations. Clear it with `pulumi cancel --yes`, then re-run the deploy. A *failed* update is different: it leaves pending operations in state, and re-running the deploy clears them.
- Run long `pulumi up` commands in the background, so an interrupted tool call does not kill the update mid-flight.

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
4. **Refactor threshold crossed**: If a change would push a method well past ~20 lines or a file past ~200–300 lines, stop before implementing. Propose moving the cohesive concern into a new module/class instead of adding another private method to an already oversized class.

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
- **Secrets stay local**: Prefer `pulumi config` (run in the stack folder) or `pulumi config --cwd <stack> --stack <name>` to read config. Note how Pulumi CLI handles secrets:
  - `pulumi config get <key>` **always** prints the plaintext value, even for secrets (and does **not** accept a `--show-secrets` flag). Therefore, agents must **never** run `pulumi config get` on a secret key; give the user `pulumi config get <key>` to run in their own terminal.
  - `pulumi config` (listing all entries) and `pulumi stack output` redact secrets unless `--show-secrets` is passed. Agents must never pass `--show-secrets`; when a secret value is needed by the user, give them `pulumi config get <key>` or `pulumi stack output --show-secrets` to run themselves so plaintext secrets never traverse the session. Reading non-secret config values (paths, sizes, flags) is fine via the agent.
- **Config defaults live in `Pulumi.yaml` only**, never duplicated in code. If a setting has a default there, read it with the `require*` accessor (`config.requireBoolean`, `config.requireNumber`, …) rather than `config.getBoolean(…) ?? false` — the `??` form leaves the same default in two places where it can drift. Reserve `get*` plus `??` for settings that have no default anywhere.
- **Applications** use the Application class for Kubernetes resources (including namespaces and storage for Helm charts).
- **Never describe your infrastructure in committed docs or commit messages.** No real hostnames, IPs, or machine names — use `example.com`, `<node>`. Commit messages are read by the same people as the docs.
- **The library sizes the containers it creates.** A component sizes its own container with `resources`; the init containers, database containers and the database operator's metrics exporter are sized by the constants in `packages/pulumi/src/resources.ts`, so no component specifies them.
- **Writing TypeScript** (components, stacks, `@orangelab/pulumi` library): follow the `code-conventions` skill.
- **Sizing container cpu/memory requests and limits** (or diagnosing OOMs, memory pressure, CPU throttling): follow the `resource-tuning` skill. Size from measured RSS, not working set.
- **Writing docs** (component `<app>.md`, stack `README.md`): follow the `document-app` / `document-module` skills. Keep user-facing component pages short; put detailed failure behaviour and operational runbooks in `spec/*.md` and link to them.

## Specs

Agent-facing operating notes. Read as needed:

- [`spec/headscale.md`](spec/headscale.md) — control plane invariants, CLI gotchas, migration constraints
- [`spec/longhorn.md`](spec/longhorn.md) — volume provisioning, failure behaviour, recovery
- [`spec/pocket.md`](spec/pocket.md) — OIDC provider, group model, client scripts, onboarding new apps
