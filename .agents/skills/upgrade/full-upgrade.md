# Full Upgrade Path (Steps 2-11)

Follow these steps only when Step 1 found breaking changes affecting enabled apps.

### Step 2: Verify Storage Safety (Static Volumes)

**Tell user**: "Before making any changes, I'll verify your storage configuration. Apps using static volumes (`fromVolume`) can be safely disabled and re-enabled without losing data - the Longhorn volume just gets detached and can be reattached. Apps using dynamic volumes will lose their storage if disabled."

**IMPORTANT**: Never include Longhorn or cert-manager in the list of apps to disable. These are core infrastructure:

- **Longhorn** - Storage backend that manages all volumes; it doesn't use volumes itself
- **cert-manager** - Stores certificates in CRDs that would be lost if disabled

**Run this read-only command** to get a categorized list of all enabled apps by volume type.

The script reads the config of the stack it runs from, so run it from the core stack AND from each module stack (from Step 1) that has affected apps:

```bash
# From repository root (core stack)
./scripts/list-volumes.sh

# From each affected module stack (script is at repository root)
cd stacks/<module> && ../../scripts/list-volumes.sh && cd ../..
```

The script outputs two sections:

- **Static volumes (fromVolume)**: Apps with static volumes, safe to disable/re-enable
- **Dynamic volumes**: Apps without `fromVolume`, data loss risk if disabled

**Cross-reference** the script output with apps affected by breaking changes from Step 1:

- Apps listed under "Static volumes" are safe to disable
- Apps listed under "Dynamic volumes" need attention before disabling

**Report to user**:

```
Storage Safety Check (only for apps with breaking changes):

Safe to disable (static volumes):
  [apps from breaking changes list that appear under "Static volumes"]

WARNING - dynamic volumes (data loss risk if disabled):
  [apps from breaking changes list that appear under "Dynamic volumes"]

Not affected (disabled or no breaking changes):
  [remaining apps]
```

**If any apps with breaking changes appear under "Dynamic volumes"**:

1. **WARNING**: Tell user: "This app uses a dynamic volume. If we disable it, the PersistentVolume and its data will be deleted."
2. **Show user commands** to convert to static volume:

    ```
    👉 Run in your terminal (or use !command in OpenCode), in the app's stack directory:

       # Set storageOnly to keep volume while disabling app resources
       pulumi --cwd stacks/<module> config set <app>:storageOnly true
       pulumi --cwd stacks/<module> up

       # Then clone volume in Longhorn UI with descriptive name (e.g., app name)
       # Finally, attach the static volume:
       pulumi --cwd stacks/<module> config set <app>:fromVolume <volume-name>
       pulumi --cwd stacks/<module> config delete <app>:storageOnly
    ```

3. **Ask user**: "Have you set up static volumes for these apps, or do you accept the data loss risk?"

**Ask user**: "Continue to Step 3: Extract and Save Secrets?"

### Step 3: Extract and Save Secrets

**Tell user**: "Before disabling apps, you need to save encryption keys and database passwords to your Pulumi config. This ensures the same credentials are used when re-enabling apps. You must run these commands yourself - I cannot see secrets."

**IMPORTANT: You (LLM) must NOT run any `--show-secrets` commands.** The user must handle secrets directly.

**Apps with secrets**: `n8n` (encryption key + PostgreSQL), `nextcloud` (MariaDB), `mempool` (MariaDB)

**Tell user**: "Check which apps from Steps 1-2 are ENABLED and need secrets saved. Look up the config key names in the app's component source (e.g. `components/<category>/<app>/<app>.ts` or `stacks/<module>/components/...`) and output paths in `pulumi stack output --json` from the stack where the app is deployed."

**Show user commands to run in their terminal**:

```
👉 Run in your terminal (NOT in OpenCode - secrets should stay local):

   # View all outputs to find your app's secrets (run in the app's stack directory)
   pulumi --cwd stacks/<module> stack output --show-secrets --json

   # Get secret value and save to config (same stack directory)
   pulumi --cwd stacks/<module> stack output <module> --show-secrets --json | jq -r '.<app>.<path>'
   pulumi --cwd stacks/<module> config set <app>:<config-key> "<value>" --secret
```

**Tell user**: "Run the relevant commands for your ENABLED apps. Don't share the output with me. Type 'done' when complete."

**When user types "done", run verification** (core first, then each affected module stack):

```bash
pulumi config
pulumi --cwd stacks/<module> config
```

**Verify** the relevant secret configs are present for the apps being disabled. If any are missing, ask user to run the commands again.

**Why this matters**:

- **Encryption keys**: Without the original key, encrypted data (like n8n workflow credentials) cannot be decrypted
- **Database passwords**: When apps are re-enabled, the password must match what's stored in the database

**If secrets are not in outputs** (app was never deployed):

- Restore-critical secrets (`n8n:N8N_ENCRYPTION_KEY`, `open-webui:WEBUI_SECRET_KEY`, `nextcloud:adminPassword`, `rustfs:rootPassword`, `prometheus:grafana/password`) are required config - deployment fails without them; fresh installs must set them before first deploy
- For recovery from backup, see `components/data/mariadb-operator/mariadb-operator.md` for MariaDB reset procedure

**Ask user**: "Continue to Step 4: Update K3s Nodes?"

### Step 4: Update K3s Nodes

**Tell user**: "It's recommended to update K3s on your cluster nodes to apply configuration changes."

**Run these commands** to display the update scripts:

```bash
cat ./scripts/k3s-server.sh
echo "---"
cat ./scripts/k3s-agent.sh
```

**Explain to user**:

- The scripts generate k3s install commands with correct configuration
- Server script updates the K3s control plane node
- Agent script updates K3s worker nodes

**Show user instructions**:

```
👉 Run these steps on your nodes (SSH required):

   Update one node at a time, starting with a non-critical agent, and wait for
   `kubectl get node <node>` to report Ready before the next. Each reinstall
   rewrites the node's systemd unit and restarts k3s.

   K3s agent update (run on each agent node):
     1. SSH to agent: ssh root@<agent-node>
     2. Copy the agent script content shown above
     3. Execute it
     4. Verify: systemctl status k3s-agent.service
     5. Apply role labels from the management node: ./scripts/k3s-label-node.sh <agent-node>

   K3s server update (run on your server node):
     1. SSH to server: ssh root@<server-node>
     2. Copy the server script content shown above
     3. Execute it
     4. Verify: systemctl status k3s.service
     5. Apply role labels from the management node: ./scripts/k3s-label-node.sh <server-node>
```

**After user confirms nodes updated, verify** by running:

```bash
kubectl get nodes -o wide
kubectl get nodes --show-labels
```

**Explain required labels**:

- `node-role.kubernetes.io/longhorn=true` - at least one node needed for Longhorn storage
- `topology.kubernetes.io/zone=home` - for location-aware apps like home-assistant
- GPU nodes are automatically detected and labeled by Node Feature Discovery (NFD)

**If node labels need updating**, add them to `orangelab:nodes` in the core stack config. Run `scripts/k3s-label-node.sh <node>` after changing role labels (they are applied through the API; kubelet refuses them on `--node-label`), or re-run the install script after changing taints or kubelet-safe labels. Do not label nodes manually. See [`docs/configuration.md`](/docs/configuration.md#node-topology-labels-and-taints).

Do not update all nodes in parallel: a failed reinstall takes that node (and its
Longhorn replicas) out of the cluster. Verify each node is `Ready` before
starting the next.

**Ask user**: "Have you updated your K3s nodes and verified labels? Continue to Step 5: Disable Apps?"

### Step 5: Disable Apps with Breaking Changes

**Tell user**: "I'll guide you to disable apps that have breaking changes. Since we verified static volumes are configured, the Longhorn volumes will be detached (not deleted) and can be reattached after the upgrade."

**NEVER disable**: Longhorn, cert-manager (see Step 1). For these, apply config migrations directly.

**Apps with manual uninstall steps** (check `components/<category>/<app>/<app>.md` "Uninstall" section if disabling):

- `tailscale` - Remove leftover machines with `tag:orangelab` at https://login.tailscale.com/admin/machines, delete CRDs
- `cloudnative-pg` - Delete CRDs (required before reinstalling)
- `prometheus` - Disable component monitoring first, then delete CRDs
- `nfd` - Delete CRDs
- `amd-gpu-operator` - Delete CRDs

**Show user the commands** for apps identified in Step 1 (excluding Longhorn/cert-manager), grouped by the stack each app lives in:

```
👉 Run in your terminal (or use !command in OpenCode):

   # Core stack apps
   pulumi config set <app>:enabled false

   # Module stack apps (repeat per stack)
   pulumi --cwd stacks/<module> config set <app>:enabled false
   # Repeat for each app that needs to be disabled
```

**After user disables apps, run previews** (core first, then each affected module stack):

```bash
pulumi preview --diff
pulumi preview --diff --cwd stacks/<module>
```

**Analyze the preview**:

- Look for PersistentVolume and PersistentVolumeClaim being removed
- Explain this is EXPECTED - the underlying Longhorn volume persists
- Check that only the intended apps are being disabled

**Tell user**: "Preview shows [X] apps will be disabled. The PersistentVolumes will be removed, but Longhorn volumes persist (they'll show as 'Detached' in Longhorn UI)."

**Show user the apply commands** (core first, then module stacks):

```
👉 Review the previews above. If they look correct, run:

   # Core stack first
   pulumi up

   # Then each affected module stack
   pulumi --cwd stacks/<module> up
```

**After user applies**, ask them to share the output or confirm success.

```
Apps disabled:
- [list of apps from user's report]

Resources removed:
- Application resources (Deployment, Service, Ingress) removed
- PersistentVolume/PersistentVolumeClaim removed (Longhorn volumes detached)
```

**Ask user**: "Continue to Step 6: Pull Latest Changes?"

---

### Step 6: Pull Latest Changes

**Tell user**: "Now we need to pull the latest code changes using git rebase to keep your history clean."

**Check for uncommitted changes** by running:

```bash
git status
```

**If there are uncommitted changes**, ask user: "You have uncommitted changes. Do you want to: (a) stash them, (b) commit them, or (c) abort upgrade?"

**Show user commands to pull and update**:

```
👉 Run in your terminal (or use !command in OpenCode):

   git pull --rebase origin main
   npm install
   npm test
```

**After user completes**, verify by running:

```bash
git log --oneline -5
npm test
```

**Report to user**:

```
Pull status: [success/failure]
Merge conflicts: [none/resolved]
Tests: [passed/failed]
```

**If merge conflicts**, STOP and help user resolve them.

**Ask user**: "Continue to Step 7: Preview Infrastructure Changes?"

---

### Step 7: Preview Infrastructure Changes

**Tell user**: "I'll run Pulumi previews to check for any unexpected infrastructure changes before applying."

**Run previews** (core first, then each initialized module stack):

```bash
pulumi preview --diff
pulumi preview --diff --cwd stacks/<module>
```

**Analyze the output carefully**:

1. Look for EXPECTED changes (from breaking changes identified in Step 1)
2. Look for UNEXPECTED changes
3. Look for resource replacements or deletions that seem wrong

**Report to user**:

```
Analysis of preview:

Expected changes:
- [list expected changes from breaking changes]

Unexpected changes:
- [list any unexpected changes] OR "No unexpected changes found"

Potential issues:
- [list any concerns like resource replacements]
```

**If unexpected changes found**, explain what they are and suggest investigation.

**Ask user**: "Preview looks correct. Continue to Step 8: Apply Infrastructure Changes?"

---

### Step 8: Apply Infrastructure Changes

**Tell user**: "Now we'll apply the infrastructure changes to upgrade your cluster."

**Show user the apply commands** (core first - module stacks depend on core CRDs/storage/ingress):

```
👉 Run in your terminal (or use !command in OpenCode):

   # Core stack first
   pulumi up

   # Then each module stack
   pulumi --cwd stacks/<module> up
```

**After user applies**, ask them to share the output or report status.

**If user reports errors**:

1. STOP immediately
2. Summarize the error based on user's report
3. Suggest potential resolutions (see Troubleshooting section)
4. Ask user for direction before proceeding

**If successful**, report:

```
Deployment status: SUCCESS

Changes applied:
- [list key changes from user's output]
```

**Ask user**: "Continue to Step 9: Re-enable Previously Disabled Apps?"

---

### Step 9: Re-enable Previously Disabled Apps

**Tell user**: "I'll guide you to re-enable the apps that were disabled for the upgrade."

**Show user commands** for each app disabled in Step 5, grouped by stack:

```
👉 Run in your terminal (or use !command in OpenCode):

   # Core stack apps
   pulumi config set <app>:enabled true

   # Module stack apps (repeat per stack)
   pulumi --cwd stacks/<module> config set <app>:enabled true
   # Repeat for each app that was disabled in Step 5
```

**After user re-enables apps, run previews** (core first, then each affected module stack):

```bash
pulumi preview --diff
pulumi preview --diff --cwd stacks/<module>
```

**Report to user**:

```
Apps to re-enable:
- [list of apps being re-enabled]

Preview shows:
- [summary of resources being created]
```

**Ask user**: "Preview looks correct. Continue to Step 10: Deploy Re-enabled Apps?"

---

### Step 10: Deploy Re-enabled Apps

**Tell user**: "Now we'll deploy the re-enabled apps with their new configuration."

**Show user the apply commands** (core first, then module stacks):

```
👉 Run in your terminal (or use !command in OpenCode):

   # Core stack first
   pulumi up

   # Then each affected module stack
   pulumi --cwd stacks/<module> up
```

**After user applies**, ask them to share the output or report status.

**If user reports errors**:

- STOP and summarize the error
- Check common issues:
    - Volume not found (fromVolume mismatch)
    - Database connection failed (database operator not running)
    - Database password mismatch (forgot to save in Step 3)
    - Encryption key mismatch (forgot to save in Step 3)
- Ask user for direction

**Report to user** for each app:

```
Deployment status for [app-name]: SUCCESS/FAILED

If failed: [error details from user]
```

**Ask user**: "When deployment is complete, type 'done' to continue to Step 11: Validate Upgrade."

---

### Step 11: Validate Upgrade

**Tell user**: "I'll verify that your services are running correctly by checking ingress endpoints and pod health."

**Run these read-only commands**:

```bash
# Check if custom domain is configured (core stack)
pulumi config get customDomain 2>/dev/null

# Get list of deployed apps (no secrets) - core first, then each module stack
pulumi stack output --json
pulumi --cwd stacks/<module> stack output --json

# Check pod status
kubectl get pods -A | grep -v Running | grep -v Completed

# Check for crashlooping pods
kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded
```

**For endpoint health checks**, run or show user:

```bash
# For each endpoint URL from the stack outputs
curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 <url>
```

**Check ingress controllers**:

```bash
# If customDomain is set - check Traefik
kubectl get pods -n traefik
kubectl get ingressroutes -A

# For all setups - check Tailscale operator (used for TCP routes even with custom domain)
kubectl get pods -n tailscale
kubectl get svc -n tailscale
```

**Expected output** (with custom domain):

```
Endpoint Health Check:
  https://ollama.example.com: 200 OK
  https://nextcloud.example.com: 200 OK
  https://grafana.example.com: 302 (redirect, OK)

Ingress Status:
  Traefik: Running (custom domain routing)
  Tailscale: Running (TCP routes, direct access)

Pod Status:
  All pods running normally

Upgrade Status: SUCCESS
```

**Expected output** (Tailscale only):

```
Endpoint Health Check:
  https://ollama.tail12345.ts.net: 200 OK
  https://nextcloud.tail12345.ts.net: 200 OK
  https://grafana.tail12345.ts.net: 302 (redirect, OK)

Ingress Status:
  Tailscale: Running

Pod Status:
  All pods running normally

Upgrade Status: SUCCESS
```

**Report final upgrade status to user**:

```
╔════════════════════════════════════════════════════════════╗
║                    UPGRADE COMPLETE                        ║
╠════════════════════════════════════════════════════════════╣
║ Version upgraded: X.X.X -> Y.Y.Y                           ║
║ Apps upgraded: [list]                                      ║
║ Endpoints verified: [list]                                 ║
║ Ingress mode: [Traefik with custom domain / Tailscale]     ║
║                                                            ║
║ Status: SUCCESS / PARTIAL / FAILED                         ║
║                                                            ║
║ Remaining issues:                                          ║
║ - [any issues or manual steps needed]                      ║
╚════════════════════════════════════════════════════════════╝
```

**If validation failed**, list problems found and suggest fixes from Troubleshooting section.

---

# TROUBLESHOOTING

Use this section when issues occur during any step.

## Common Issues

1. **Volume not found**: Ensure `fromVolume` matches an existing Longhorn volume name in Longhorn UI
2. **Database connection failed**: Check if database operator pods are running
3. **Database password mismatch**: Password in config doesn't match what's stored in the restored database
    - This happens if you forgot to save the password before disabling the app
    - For MariaDB, see reset procedure in `components/data/mariadb-operator/mariadb-operator.md`
    - For PostgreSQL, use `pg-restore.sh` script to restore from dump, or reset password manually
4. **Encryption key mismatch**: App cannot decrypt data because key changed
     - This happens if you forgot to save the encryption key before disabling the app
     - If app is still running, user can extract from Pulumi output in their terminal, from the app's stack directory: `pulumi --cwd stacks/<module> stack output <module> --show-secrets --json | jq -r '.<app>.encryptionKey'`
     - If app was already removed, data encrypted with old key is unrecoverable
5. **Ingress not responding**:
    - With custom domain: Check Traefik pods `kubectl get pods -n traefik` and cert-manager `kubectl get certificates -A`
    - Tailscale routes: Check operator `kubectl get pods -n tailscale` and services `kubectl get svc -n tailscale`
6. **Pod crashlooping**: Check logs with `kubectl logs -n <namespace> <pod>`
7. **Pulumi state conflict**: May need `pulumi refresh` to sync state
8. **App stuck deploying**: Guide user to try `storageOnly` mode to keep storage while removing app resources (run in the app's stack directory):

    ```
    👉 Run these commands in your terminal:

       pulumi --cwd stacks/<module> config set <app>:enabled true
       pulumi --cwd stacks/<module> config set <app>:storageOnly true
       pulumi --cwd stacks/<module> up

       pulumi --cwd stacks/<module> config delete <app>:storageOnly
       pulumi --cwd stacks/<module> up
    ```

## Recovery Options

Guide user with these commands if needed:

- **Rollback code**: `git checkout <previous-commit>`
- **Rollback infrastructure**: Pulumi maintains state history, but app data may be affected
- **Skip problematic app**: `pulumi --cwd stacks/<module> config set <app>:enabled false` (in the app's stack) and continue with rest of upgrade
- **Restore from backup**: Use Longhorn UI to restore volume from backup, then `pulumi --cwd stacks/<module> config set <app>:fromVolume <volume-name>`

---

# REFERENCE

## Command Summary

All Pulumi commands run against the stack in the current directory. Use `pulumi --cwd <dir> ...` to target the core stack (repository root) or a module stack (`stacks/<module>`). Core always goes first.

**LLM can safely run (read-only)**:

- `pulumi config` (NO `--show-secrets`)
- `pulumi preview --diff`
- `pulumi stack output --json` (NO `--show-secrets`)
- `git status`, `git log`, `git fetch`, `git diff`
- `kubectl get ...` (any read operations)
- `gh release list`, `gh release view` (if configured)
- WebFetch for GitHub releases page (fallback)
- `npm test`
- `cat`, `curl` for reading files/endpoints

**User must run** (in terminal or via `!command` in OpenCode):

- `pulumi up`
- `pulumi config set ...`
- `pulumi config delete ...`
- `git pull`, `git checkout`, `git stash`
- `npm install`
- Any command with `--show-secrets`
- SSH commands to nodes
