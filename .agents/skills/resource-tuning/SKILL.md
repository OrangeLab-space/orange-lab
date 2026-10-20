---
name: resource-tuning
description: Use when diagnosing or fixing container cpu and memory requests and limits — OOM kills, pods evicted for memory, low memory on a host, a memory limit being hit, CPU throttling, or a slow/high-CPU app. Trigger on phrases like "OOM", "out of memory", "killed", "memory limit", "low memory on the host", "node under memory pressure", "CPU throttling", "performance", "requests and limits", "resource sizing", "too much memory reserved", "BestEffort". Not for storage volume expansion (use resize-storage).
---

# Resource Tuning (CPU & Memory Requests/Limits)

Sizes container requests and limits from measured usage, and diagnoses the failure
modes that come from getting them wrong.

## The distinction that decides everything: RSS vs working set

| Metric | What it is | Use it for |
| :--- | :--- | :--- |
| `container_memory_rss` | Anonymous memory the process actually holds | **Sizing the request and the limit** |
| `container_memory_working_set_bytes` | RSS + reclaimable page cache | **Measuring the node's impact** |

Page cache is reclaimable. A pod with an 8 GiB working set and 1.7 GiB RSS does
not need 8 GiB — it needs 1.7 GiB plus whatever cache the kernel is holding for
it. Sizing a request off the working set over-reserves by the cache size; sizing
a limit off the working set OOM-kills the process.

`kubectl top` shows working set, so it systematically overstates the need. Always
pull both metrics.

Two failure modes that look identical from `kubectl top`:

- **Working set pinned at the limit, RSS well below it** — the kernel is
  reclaiming continuously. Not an OOM; the app is slow because it keeps
  re-reading from disk. Fix: raise the limit.
- **RSS at the limit** — the process is genuinely out of memory. Fix: raise the
  limit *and* the request.

## What requests and limits actually do

| | Request | Limit |
| :--- | :--- | :--- |
| Scheduler | Reserves capacity; the pod is not scheduled onto a node without it | Not considered |
| Node pressure | Pod is evicted after Guaranteed/Burstable peers | Pod is OOM-killed or CFS-throttled at the ceiling |
| QoS class | — | request == limit ⇒ Guaranteed, otherwise Burstable |

A pod with **no** request at all is `BestEffort`: it is scheduled first onto any
node and evicted first under pressure. A missing CPU request on an otherwise
memory-tuned pod still leaves it CPU-BestEffort.

## Workflow

### 1. Establish the baseline

```sh
kubectl get nodes -o custom-columns=NAME:.metadata.name,CPU:.status.allocatable.cpu,MEM:.status.allocatable.memory
kubectl describe node <node> | grep -A8 "Allocated resources"
```

If requests sit at 20–25 % of allocatable there is **no scheduling pressure** —
the problem is correctness, not capacity, and the fix is about eviction ordering
and node stability rather than freeing room. Say this explicitly before
proposing changes, so nobody expects a capacity win that will not happen.

Inventory what declares requests and limits today:

```sh
kubectl get deploy,statefulset,daemonset -A -o json | jq -r '
  .items[] | select(.spec.template.spec.containers | any(.resources.requests != null)) |
  "\(.kind) \(.metadata.namespace)/\(.metadata.name) :: " +
  (.spec.template.spec.containers |
    map("\(.name) req=\(.resources.requests.cpu // "-")/\(.resources.requests.memory // "-") lim=\(.resources.limits.cpu // "-")/\(.resources.limits.memory // "-")") |
    join(" | "))'
```

Workloads with **no** `resources` block are BestEffort:

```sh
kubectl get pods -A -o json | jq -r '.items[] | select(.status.phase=="Running")
  | select(.status.qosClass=="BestEffort") | .metadata.namespace' | sort -u
```

### 2. Measure actual usage

The in-cluster Prometheus holds the history. Port-forward it:

```sh
kubectl -n prometheus port-forward svc/prometheus-prometheus 19090:9090 &
```

Peak RSS and peak working set over the last 7 days:

```sh
NS='<namespace-regex>'
curl -s --data-urlencode "query=max_over_time(container_memory_rss{namespace=~\"$NS\",container!=\"POD\"}[7d])" \
  http://localhost:19090/api/v1/query | jq -r '.data.result[] | "\(.metric.namespace)/\(.metric.container) \(.value[1]|tonumber/1048576|round)Mi"' | sort -u

curl -s --data-urlencode "query=max_over_time(container_memory_working_set_bytes{namespace=~\"$NS\",container!=\"POD\"}[7d])" \
  http://localhost:19090/api/v1/query | jq -r '.data.result[] | "\(.metric.namespace)/\(.metric.container) \(.value[1]|tonumber/1048576|round)Mi"' | sort -u
```

Peak CPU (cores → millicores), bucketed hourly so a startup burst is
distinguishable from steady state:

```sh
curl -s --data-urlencode "query=max_over_time(rate(container_cpu_usage_seconds_total{namespace=~\"$NS\",container!=\"POD\"}[5m])[1h:1m])" \
  "http://localhost:19090/api/v1/query_range?start=$(date -d '7 days ago' +%s)&end=$(date +%s)&step=1h" |
  jq -r '.data.result[] | .metric.container as $c | .values[] | "\($c) \(.[1]|tonumber*1000|round)"' |
  awk '{a[$1]=a[$1]" "$2} END{for(k in a) print k, a[k]}'
```

A single value in the CPU series means a one-off burst (startup, index scan,
model load) — size the request on the sustained value and the limit above the
burst, not on the burst.

Check how far back the series actually goes before trusting a "peak": a young pod
has no history, and its peak is whatever it happened to do since it started.

```sh
curl -s "http://localhost:19090/api/v1/status/tsdb" | jq -r '.data.headStats'
```

### 3. Classify each workload

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| Working set at the limit, RSS well below | Page cache thrashing | Raise the limit |
| RSS at the limit, restarts with OOMKilled | Genuine memory exhaustion | Raise the limit **and** the request |
| No requests at all | BestEffort pod | Add requests; add a limit |
| Request well below actual usage | Under-reserved | Raise the request |
| Request far above actual usage | Wasted reservation, blocks scheduling | Lower the request |
| Host memory climbing, one pod's working set climbing | Unbounded cgroup — the pod starves its *neighbours* | Cap it with a limit |
| CPU throttling, `container_cpu_cfs_throttled_seconds_total` rising | Limit below the burst | Raise the CPU limit |
| Slow app, plenty of free node memory | Working set pinned at the limit, re-reading from disk | Raise the limit |

The "one pod starves the node" case is the one that gets missed. A pod with no
limit grows its page cache until the **node** is under pressure, and then the
kubelet evicts innocent pods. The pod itself never looks unhealthy.

### 4. Choose the values

- **Request** ≈ peak RSS, rounded up to a clean size, plus headroom for the
  normal working range. A request below actual usage is legal (Burstable) but
  means the pod is permanently over its reservation and gets evicted ahead of
  pods that are not.
- **Limit** ≈ 1.5–2× the request, or 2–3× peak RSS for file-I/O-heavy apps
  whose cache churns. Never set a limit below the observed peak RSS.
- **CPU request** ≈ sustained usage, not the burst. Peaks come from startup,
  index scans and model loads.
- **CPU limit** ≈ 2× the peak, or omit. Only add one when the pod can starve a
  node during a burst; CFS throttling shows up as latency, not as an error.
- **A missing request is worse than a wrong limit.** A pod with no request lands
  on a loaded node and gets evicted first.

### 5. Change it in Pulumi — never with kubectl

A `kubectl patch` drifts from the Pulumi state and the next `pulumi up` reverts
it. Resource values live in TypeScript (`resources` on `ContainerSpec`) or in
Helm chart values.

**Deployments** (`app.addDeployment`) — `resources` on the container spec:

```ts
resources: {
    requests: { cpu: '800m', memory: '2Gi' },
    limits: { cpu: '2', memory: '4Gi' },
},
```

**Helm charts** (`app.addHelmChart`) — set `resources` in the chart `values`.
Most charts take a top-level `resources`; `kube-prometheus-stack` takes
per-component keys. The exact path per chart is listed under
[Chart resource keys](#chart-resource-keys) below.

Three Helm-specific traps:

- A chart that ships `resources: {requests: {}, limits: {}}` — the default in
  most charts — leaves the pod **BestEffort**. Check the chart's `values.yaml`,
  not just the rendered manifest.
- A chart whose commented example is a generic placeholder is not a
  recommendation. Size from measurement.
- Charts that merge a GPU limit into `limits` (e.g. `ollama-helm` does
  `mergeOverwrite .Values.resources`) keep the GPU key when you set a partial
  `limits` object — verify in the rendered manifest rather than assuming.
- **A Deployment with a ReadWriteOnce PVC deadlocks on `RollingUpdate`.** The
  surge pod cannot attach the volume while the old pod still holds it, so the
  new pod sits in `ContainerCreating` and the Helm release eventually fails with
  `failed to become available within allocated timeout`. The pod event says
  `FailedAttachVolume: Volume is already used by pod(s) ...`. Set the
  deployment's strategy to `Recreate` (chart key: `deploymentStrategy` for
  grafana, `nextcloud.strategy` for nextcloud, `strategy` for vaultwarden).
  StatefulSets are not affected — they update one pod at a time.

#### Chart resource keys

Verify a key against the chart version that is deployed before using it — the
path moves between chart majors. The values schema is in the chart's
`values.yaml`; the authoritative check is which key the chart's **template**
reads:

```sh
tar -xzf <chart>.tgz -O --wildcards '*/values.yaml' > values.yaml
tar -xzf <chart>.tgz -O --wildcards '*/templates/*.yaml' | grep -rhoE '\.Values\.[a-zA-Z0-9_.-]*resources' | sort -u
```

Paths used by the charts in this repository:

| Chart | Values path | Workload |
| :--- | :--- | :--- |
| `kube-prometheus-stack` | `prometheus.prometheusSpec.resources` | prometheus |
| | `grafana.resources` | grafana |
| | `alertmanager.alertmanagerSpec.resources` | alertmanager |
| | `kube-state-metrics.resources` | kube-state-metrics |
| | `prometheus-node-exporter.resources` | node-exporter |
| | `prometheusOperator.resources` | prometheus-operator |
| `longhorn` | `longhornManager.resources` | longhorn manager daemonset |
| | `longhornGlobalManager.resources` | longhorn global manager |
| | `defaultSettings.systemManagedCSIComponentsResourceLimits` | CSI components (a Longhorn **Setting**, not a pod spec — changing it restarts the CSI components) |
| `cert-manager` | `resources`, `cainjector.resources`, `webhook.resources` | controller, cainjector, webhook |
| `cloudnative-pg` | `resources` | operator manager |
| `mariadb-operator` | `resources`, `webhook.resources`, `certController.resources` | controller, webhook, cert controller |
| `traefik` | `resources` | traefik |
| `home-assistant` | `resources` | home-assistant |
| `vaultwarden` | `resources` | vaultwarden |
| `nextcloud` | `resources`, `cronjob.cronjob.resources` | nextcloud, nextcloud-cron |
| `node-feature-discovery` | `master/worker/gc/topologyUpdater.resources` | chart sets these already |

Some workloads are **not reachable through chart values** — do not burn time on
them: the grafana `grafana-sc-dashboard` / `grafana-sc-datasources` sidecar
deployments and the GPU operator's device-plugin, node-labeller and
workflow-controller have no `resources` key in their chart templates. The
`config-reloader` sidecar that the prometheus-operator injects into the
prometheus and alertmanager pods is likewise not tunable from the chart.

**Subchart values are keyed by the subchart's own name, not by the parent's
alias.** In `kube-prometheus-stack` the parent's `kubeStateMetrics.enabled` and
`nodeExporter.enabled` only toggle the subcharts — the subchart's own values
live under `kube-state-metrics` and `prometheus-node-exporter`. Putting
`resources` under the aliased key previews fine and silently does nothing.

**A `pulumi preview` of a Helm release shows the `values` diff, not the rendered
manifest.** A wrong key path therefore previews as a harmless-looking values
change and silently does nothing. Always confirm in the live cluster after the
deploy:

```sh
kubectl -n <ns> get deploy,statefulset,daemonset -o json | jq -r '
  .items[] | .metadata.name as $n | .spec.template.spec.containers |
  map("\($n)/\(.name) req=\(.resources.requests.cpu // "-")/\(.resources.requests.memory // "-") lim=\(.resources.limits.cpu // "-")/\(.resources.limits.memory // "-")") | join(" | ")'
```

### 6. Preview, deploy, verify

```sh
cd stacks/<module> && pulumi preview --diff
```

Check the diff contains **only** resource changes before deploying. A
`pulumi up` that reports `errored` leaves pending operations in state and the
next run has to clear them — re-run it and confirm `pending_operations` is 0:

```sh
pulumi stack export | jq -r '.deployment.pending_operations | length'
```

A `pulumi up` that is **killed** (interrupted, not failed) leaves the stack
showing an active update with no pending operations in state. Clear it with
`pulumi cancel --yes`, then re-run the deploy:

```sh
pulumi cancel --yes
pulumi up --yes
```

Run long deploys in the background so an interrupted tool call does not kill
them mid-update.

## Repo-specific gotchas

- **The library owns the sizing of the containers it creates.** Main containers
  take `resources` from the caller, but the library also creates init
  containers (`wait-for-db`, `fix-volume-permissions`), database containers and
  the database operator's metrics exporter. Those are sized from the constants
  in `packages/pulumi/src/resources.ts` — `INIT_CONTAINER_RESOURCES`,
  `DATABASE_RESOURCES`, `REDIS_RESOURCES`, `METRICS_EXPORTER_RESOURCES` — so
  callers never specify them. Change the constant, not the app, and run
  `npm run build` before deploying. The constants are exported from
  `@orangelab/pulumi` for components that render their own metrics exporter.
- **The Caddy proxy sidecar** that `addHostNetworkProxy()` injects carries its own
  defaults (`10m`/`32Mi` request, `64Mi` limit) in
  `packages/pulumi/src/application.ts`.
- **GPU limits are added by the library**, not by the app. `containers.ts`
  `createResourceLimits` adds `nvidia.com/gpu: 1` when the app is configured for
  NVIDIA; AMD and Intel use device mounts instead.
- **Workloads whose footprint depends on a payload** (an LLM server, a database
  with a variable working set) should get a request but **no memory limit**.
  `ollama` is the worked example: the resident model sets the footprint and the
  available models differ by more than 10×, so a limit sized for the current
  model OOM-kills the server when a larger one is pulled. Request for the
  common case, cap the CPU, leave memory open.
- **A container that sizes its own cache from the cgroup limit** will change
  behaviour when you change the limit. Bitcoin Core auto-tunes its UTXO cache
  from the memory limit, so raising it makes the node use more memory than it
  did before — the request should follow.
- **Values are hardcoded in TypeScript**, matching every other component. There
  is no `Pulumi.yaml` config surface for resources; if per-deployment
  tunability is wanted, the defaults belong in `Pulumi.yaml` and the code
  should read them with the `require*` accessors.
- **Adding keys to a Helm `values` object can trip `sort-keys`.** The lint rule
  is configured with `minKeys: 10`, so an object with fewer than ten keys is
  never checked — and may already be in a non-alphabetical order. Adding the
  tenth key activates the rule and the whole object then has to be sorted.
  Reorder the object rather than working around the lint error.

## Verify

- Baseline established first — whether there is real pressure was stated before
  any change was proposed
- Both RSS and working set measured; requests sized from RSS
- Every changed value traced to a measurement, not a guess
- Preview shows only resource changes
- All stacks report 0 pending operations after the deploy
- Every pod Running and every Deployment fully ready afterwards
- Node utilisation and the QoS class of the changed pods re-checked
