---
name: install-app
description: Use when the user asks to install, enable, set up, or deploy an application in OrangeLab. Trigger on phrases like "install <app>", "enable <app>", "deploy <app>", or "set up <app>".
---

# Install Application

Guides the user through installing an OrangeLab application — from discovering configuration and creating static Longhorn volumes, to configuring Pocket ID OIDC and verifying endpoints.

## References

- Available applications and stack layout: [`README.md`](/README.md#available-applications)
- Module / stack overview docs (general hints, shared settings, and architecture for a module or stack):
  - Core modules: `components/<module>/<MODULE>.md` (e.g. [`NETWORK.md`](/components/network/NETWORK.md), [`STORAGE.md`](/components/storage/STORAGE.md), [`HARDWARE.md`](/components/hardware/HARDWARE.md), [`DATA.md`](/components/data/DATA.md), [`MONITORING.md`](/components/monitoring/MONITORING.md), [`SECURITY.md`](/components/security/SECURITY.md))
  - Application stacks: `stacks/<module>/README.md` (e.g. [`stacks/apps/README.md`](/stacks/apps/README.md), [`stacks/ai/README.md`](/stacks/ai/README.md), [`stacks/bitcoin/README.md`](/stacks/bitcoin/README.md), [`stacks/dev/README.md`](/stacks/dev/README.md), [`stacks/iot/README.md`](/stacks/iot/README.md), [`stacks/media/README.md`](/stacks/media/README.md))
- Common application settings (`hostname`, `storageSize`, `fromVolume`, `network/public`, `auth`, node placement, GPU): [`docs/configuration.md`](/docs/configuration.md)
- Longhorn storage classes and default settings: [`components/storage/longhorn/longhorn.ts`](/components/storage/longhorn/longhorn.ts) and [`spec/longhorn.md`](/spec/longhorn.md)
- Pocket ID OIDC client setup and group access control: [`components/security/pocket/pocket.md`](/components/security/pocket/pocket.md)

## Security & Operational Rules

- **Never read or display secrets**:
  - `pulumi config get <key>` **always** prints decrypted secrets (and does not have a `--show-secrets` flag). Never run `pulumi config get` on a secret key in agent tool calls.
  - `pulumi config` (full list) and `pulumi stack output` redact secrets unless `--show-secrets` is passed. Never run `--show-secrets` in agent tool calls.
  - When a secret value needs to be generated, copied, or viewed, show the user the exact command (`pulumi config get <app>:<secretKey>` or `pulumi stack output --show-secrets`) to run in their terminal.
- **Never edit `Pulumi.<stack>.yaml` directly**: Use `pulumi config set` / `pulumi config delete`.
- **Confirm before cluster/state changes**: Always ask the user for confirmation before creating Longhorn volumes or running `pulumi up`.
- **Keep bash commands simple and readable**: In the happy path, run plain, easy-to-follow `pulumi`, `kubectl`, and `curl` commands — avoid inline Python scripts, complex `jq`/`awk` pipelines, or obscure shell one-liners so the user can easily read, understand, and approve every command. Reserve complex commands strictly for debugging if something goes wrong.

---

## Workflow

### 1. Locate Application & Stack

1. Check [`README.md`](/README.md#available-applications) to find where the application lives:
   - **Core stack** (repository root): `components/<module>/<app>/` (`Pulumi.yaml` in root, module doc at `components/<module>/<MODULE>.md`)
   - **Optional module stacks**: `stacks/<module>/components/<app>/` (`stacks/<module>/Pulumi.yaml`, stack doc at `stacks/<module>/README.md`)
2. Read the module/stack doc (`<MODULE>.md` or `stacks/<module>/README.md`), the application's documentation (`<app>.md`), its TypeScript component (`<app>.ts`), and the stack's `Pulumi.yaml` to identify:
   - **Prerequisites**: Required operators or components (e.g. `cloudnative-pg`, `mariadb-operator`, `traefik`, `headscale`, `orangelab:coreStackRef` for module stacks).
   - **Required parameters**: Settings read via `config.require` / `config.requireSecret` without defaults in `Pulumi.yaml`, or required helper scripts (e.g. `headscale-apikey.sh`).
   - **Optional app-specific parameters**: Settings with defaults or commented out in `Pulumi.yaml` (`hostname`, `storageSize`, `image`/`version`, `gpu`, `network/public`, custom settings).
   - **Storage volumes**: Whether the app uses `addStorage()`, `addPostgres()`, `addMariaDB()`, or multiple named volumes (`<component>/storageSize`, `<component>/fromVolume`).
   - **OIDC support**: Whether a `pocket-<app>.sh` script exists or the app shares another client (like `headplane` sharing `headscale`).

### 2. Inspect Existing State & Candidate Volumes

Run read-only checks on the target stack and cluster:

```sh
# Check current stack configuration (without --show-secrets)
pulumi config --cwd <stack-dir>

# For module stacks, verify orangelab:coreStackRef is set
pulumi config get orangelab:coreStackRef --cwd stacks/<module>

# Check existing Longhorn volumes for detached candidates
kubectl get volumes.longhorn.io -n longhorn-system

# Check existing Longhorn backups for the app (and any sub-component volumes)
kubectl get backupvolumes.longhorn.io -n longhorn-system
kubectl get backups.longhorn.io -n longhorn-system -l backup-volume=<volume-name> --sort-by='.status.backupCreatedAt'

# Check available nodes, zones, and GPU labels for placement and hardware acceleration
kubectl get nodes -L topology.kubernetes.io/zone,orangelab/gpu-nvidia,orangelab/gpu-amd,orangelab/gpu-intel
```

Look for:
- Detached volumes matching `<app>`, `<app>-<component>` (e.g. `<app>-db`, `<app>-media`), or orphaned `pvc-*` volumes that might belong to a previous installation.
- Existing Longhorn S3 backups (`backups.longhorn.io` with label `backup-volume=<volume-name>`). If backups exist, list them from **latest to oldest (up to 5 maximum)** with relative timestamps (e.g. `22 hours ago`, `2 days ago`, alongside the exact timestamp).
- Core stack backup settings (`longhorn:backupEnabled` and `longhorn:backupAllVolumes`).

### 3. Consult the User on Decisions

Present a concise summary and ask the user to decide on:

1. **Required parameters / secrets**: Explain any required inputs (or offer to run helper commands that don't expose secrets).
2. **GPU / Hardware Acceleration (if supported by the app and nodes have GPUs)**:
   - If the app (or a sub-component like `immich:machine-learning/gpu`) supports GPU acceleration and cluster nodes have GPU labels (or Coral TPU for apps like `frigate`), ask which accelerator to use:
     - `none` (CPU only / unset)
     - `nvidia` (`<app>:gpu nvidia` or `<app>:<component>/gpu nvidia`)
     - `amd` (`<app>:gpu amd` or `<app>:<component>/gpu amd`)
     - `intel` (if supported by the app, e.g. `<app>:gpu intel`)
     - `coral` (if supported by the app, e.g. `frigate:coral true`)
3. **Node / Zone Placement**:
   - Default to **none** (automatic scheduling across available nodes, or automatic GPU node affinity when `<app>:gpu` is set), unless the app uses local storage (`addLocalVolume` / `addDeviceMount` / USB devices) which requires `requiredNodeLabel`.
   - Ask if they want to pin or prefer a specific host (`kubernetes.io/hostname=<node>`) or zone (`topology.kubernetes.io/zone=<zone>`), using `<app>:requiredNodeLabel` (hard constraint — note that setting this overrides automatic GPU node affinity), `<app>:preferredNodeLabel` (soft constraint), or `<app>:requiredVolumeLabel` (volume-only pin).
4. **Storage, Static Longhorn Volume(s) & Backups**:
   - **Check existing volumes or backups first**:
     - If candidate detached volumes exist in Longhorn (`<app>` or `<app>-<component>`), ask if the user wants to attach them via `fromVolume`.
     - If S3 backups exist (`backups.longhorn.io`), show the **latest up to 5 backups (newest first)** with relative timestamps (e.g. `2 days ago`). If the user wants to restore from a backup, restore the volume to `<app>` (or `<app>-<component>`) **first**, wait until the restore completes and the volume returns to `detached` state (`status.restoreRequired: false` and `status.state: detached`), and then attach it using `fromVolume`.
   - **Storage Type (`Longhorn` vs `hostPath`) & Size**:
     - Some apps/volumes support a local `hostPath` (e.g. `dataPath`, `media/hostPath`) as an alternative to Longhorn. **Prefer Longhorn** by default; mention `hostPath` as useful when the user already has existing files on a node disk (such as a media library). When `hostPath` is used, no volume size is needed (and `requiredNodeLabel` is required).
     - For Longhorn volumes (when creating a new volume), ask the user what size (`storageSize` / `<component>/storageSize`) they want, suggesting the default from `Pulumi.yaml`. Let them know that Longhorn volume sizes **can be increased later (only expanded, never shrunk)** using the `resize-storage` workflow.
     - Static volumes (`fromVolume`) are strongly recommended so data survives app redeployments and Longhorn recurring jobs apply cleanly. Naming convention: `<app>` for the main volume, `<app>-<component>` for additional volumes (e.g. `<app>-db`, `<app>-media`).
     - Offer to create new static Longhorn volume(s) via `kubectl apply`, and also show the parameters if they prefer to create/restore them in the Longhorn UI:
       - **Name**: `<app>` (or `<app>-<component>`)
       - **Size**: chosen `storageSize` (converted to bytes in the CR spec, e.g. `1Gi` = `1073741824`, `5Gi` = `5368709120`, `10Gi` = `10737418240`, `50Gi` = `53687091200`)
       - **Number of Replicas**: `2` (or `longhorn:replicaCount` from core stack config) by default; `1` for large volumes (`storageSize >= 500Gi` or `longhorn-large` / `longhorn-gpu` storage classes)
       - **Frontend**: `blockdev` (`Block Device` in UI)
       - **Data Engine**: `v1`
       - **Access Mode**: `rwo` (`ReadWriteOnce`)
   - **Volume Backups (`<app>:backupVolume` / `<app>:<component>/backupVolume`) — ask last in storage**:
     - Default to `true` (enabled) if backups for this volume already exist or if backups are generally enabled in the cluster (`longhorn:backupEnabled` / `longhorn:backupAllVolumes`).
     - For **large volumes** (`storageSize >= 500Gi`, media libraries, AI models, blockchain data, etc.): recommend **explicitly disabling backups** (`pulumi config set <app>:backupVolume false` or `<app>:<component>/backupVolume false`), even when `longhorn:backupAllVolumes` is `true`.
5. **OIDC Authentication (if supported)**:
   - Ask if they want to enable Pocket ID authentication (`<app>:auth pocket`).
   - By default, recommend restricting access to the `admin` group (`<app>:auth/allowedGroups admin`). Ask if they prefer `admin` only, `admin,power-user`, custom groups, or unrestricted access.
   - Note any app-specific role mapping (e.g. `<app>:auth/groupMap`, `<app>:auth/adminGroup`, or custom claims like `headplane_role` / `rustfs_policies`).
6. **Optional parameters**:
   - At the end, show the remaining optional settings and their defaults from `Pulumi.yaml` (e.g. `hostname`, `network/public`, app-specific flags) and ask if anything else is missing or if they want to customize any of them.

### 4. Provision or Restore Static Longhorn Volume(s)

- **If restoring from a backup**:
  - Either ask the user to restore the backup in the Longhorn UI (**Backup** → select backup → **Restore** with name `<volume-name>`), or create the `Volume` CR with `fromBackup` set to the backup's `.status.url` (e.g. `s3://backup-longhorn@lab/?backup=<backup-name>&volume=<volume-name>`).
  - **Wait for the restore to finish** before deploying the app: Longhorn attaches the volume to a node while restoring data from S3 and detaches it once complete. Verify `STATE=detached` and `restoreRequired=false`:
    ```sh
    kubectl get volumes.longhorn.io -n longhorn-system <volume-name>
    ```
- **If creating a new empty static volume**:

```sh
kubectl apply -f - <<'EOF'
apiVersion: longhorn.io/v1beta2
kind: Volume
metadata:
  name: <volume-name>
  namespace: longhorn-system
spec:
  accessMode: rwo
  dataEngine: v1
  frontend: blockdev
  numberOfReplicas: <2-or-1>
  size: "<size-in-bytes>"
EOF
```

Once the volume `<volume-name>` exists and is `detached`, show the user the `pulumi config set` command(s) being applied so they can see how to configure it manually, then wire the volume in Pulumi config:

```sh
# Main volume
pulumi config set <app>:fromVolume <app> --cwd <stack-dir>

# Sub-component or database volume (if applicable)
pulumi config set <app>:<component>/fromVolume <app>-<component> --cwd <stack-dir>
```

### 5. Configure Application & OIDC

At each configuration step, **show the exact `pulumi config set` commands to the user** so they can see how to configure the application manually.

1. Set `enabled` and any chosen parameters (placement, GPU, backups, optional overrides):
   ```sh
   pulumi config set <app>:enabled true --cwd <stack-dir>
   ```
2. **Pre-deploy OIDC setup** (for apps whose `pocket-<app>.sh` derives the URL from config, or apps that require OIDC credentials on first boot like `headscale`/`headplane`, or when the endpoint is already in stack outputs):
   - Set `<app>:auth/allowedGroups` to the user's chosen groups (default `admin`):
     ```sh
     pulumi config set <app>:auth/allowedGroups <groups> --cwd <stack-dir>
     ```
   - Run `./components/<path>/pocket-<app>.sh` from `<stack-dir>` (if the script doesn't pass `--restrict-access` automatically, pass `--restrict-access "<groups>"` or set `allowedGroups` first).
   - For a **newly created** Pocket ID client, `pocket-<app>.sh` prints the `clientSecret` to stdout. Because agents must not read secrets in tool output, either ask the user to run `./components/.../pocket-<app>.sh` in their terminal and apply the printed `pulumi config set` commands, or pipe the script output directly in shell without echoing the secret.

### 6. Review Configuration & Deploy Application

1. Once all parameters are applied and before running `pulumi up`, run `pulumi config` (never with `--show-secrets`) and **show the user the output filtered to the application's settings**:
   ```sh
   pulumi config --cwd <stack-dir> | grep -E "^(KEY|<app>:)"
   ```
2. Ask the user to confirm that the configuration looks good and whether to proceed with `pulumi up`.
3. On confirmation, run `pulumi up` in `<stack-dir>` (use a sufficient timeout as image pulls and volume attachments can take >2 minutes):
   ```sh
   pulumi up --yes --cwd <stack-dir>
   ```

**Post-deploy OIDC setup** (for apps whose `pocket-<app>.sh` reads `.endpoints.private.<app>` from `pulumi stack output` after initial deploy):
- Once the first deploy exports the endpoint, configure the Pocket ID client, show the updated `pulumi config` settings, and re-run `pulumi up --yes --cwd <stack-dir>`.

### 7. Verify & Summarize

1. **Verify health and endpoints**:
   - Check pods and PVCs in the app namespace:
     ```sh
     kubectl get pods,pvc -n <app-namespace>
     kubectl get volumes.longhorn.io -n longhorn-system <volume-name>
     ```
   - Check stack outputs (without `--show-secrets`):
     ```sh
     pulumi stack output --cwd <stack-dir>
     ```
   - Test HTTP endpoint reachability (and trigger TLS certificate provisioning):
     ```sh
     curl -sS -L -o /dev/null -w "%{http_code} %{url_effective}\n" <endpoint-url>
     ```
2. **Report to the user**:
   - **Endpoints & Stack Exports**: Show the deployed private/public/cluster endpoints and any app exports from `pulumi stack output`.
   - **Generated Secrets / Keys / Config**: Inform the user of any auto-generated passwords, encryption keys, cookie secrets, or database credentials created during deployment (e.g. `createPassword` resources in state, `<app>:users`, database secrets).
   - **Viewing Secrets Safely**: Never read secret values yourself. Show the user the exact command they can run in their own terminal if they need to inspect a generated secret, e.g.:
     ```sh
     pulumi stack output --show-secrets --cwd <stack-dir>
     # or for a specific config secret (pulumi config get always decrypts):
     pulumi config get <app>:<secretKey> --cwd <stack-dir>
     ```
   - **First-Login Owner Bootstrap & Next Steps**:
     - If the application designates the **first user who logs in** as the Owner/Admin (e.g. `headplane`, `open-webui`, `immich`, `n8n`, `droppedneedle`), explicitly advise the user to **log out of Pocket ID first** (if currently signed in as a non-admin user) and then open the application URL to sign in as `admin` first.
     - Advise on how to expose the service publicly if desired (`pulumi config set <app>:network/public true` and redeploy), or note if the app is intentionally private-only (like `headplane`).
     - Mention any post-install UI steps or Pocket ID role claims documented in `<app>.md`.
