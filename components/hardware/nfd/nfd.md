# Node Feature Discovery (NFD)

|          |                                                           |
| -------- | --------------------------------------------------------- |
| Homepage | https://kubernetes-sigs.github.io/node-feature-discovery/ |
| GitHub   | https://github.com/kubernetes-sigs/node-feature-discovery |

Node Feature Discovery (NFD) is a Kubernetes add-on that detects and advertises hardware features and system configuration as node labels. It's used to detect nodes with GPU hardware installed.

## Installation

NFD is installed automatically when either NVIDIA or AMD GPU operators are enabled.

```sh
pulumi config set nfd:enabled true
pulumi up
```

## GPU node labels

Automatic detection of AMD, NVIDIA and Intel GPUs is enabled by default.

Nodes with GPUs will have the following labels added:

For NVIDIA GPUs:

- `node-role.kubernetes.io/gpu: "true"`
- `orangelab/gpu-nvidia: "true"`

For AMD GPUs:

- `node-role.kubernetes.io/gpu: "true"`
- `orangelab/gpu-amd: "true"`

For Intel GPUs:

- `node-role.kubernetes.io/gpu: "true"`
- `orangelab/gpu-intel: "true"`

These labels can be used for node selection in applications.

If there are some nodes with GPU that should not be used for GPU workloads, you can disable auto detection and remove related labels from the node.

```sh
# Disable automatic GPU detection
pulumi config set nfd:gpu-autodetect false
pulumi up

# Remove node labels
kubectl label nodes <node_name> node-role.kubernetes.io/gpu-
kubectl label nodes <node_name> orangelab/gpu-nvidia-
kubectl label nodes <node_name> orangelab/gpu-amd-
kubectl label nodes <node_name> orangelab/gpu-intel-
```

## Alpine nodes

By default, NFD worker pods exclude nodes with the `orangelab/alpine` label. Label your Alpine nodes after joining the cluster:

```sh
kubectl label nodes <node-name> orangelab/alpine=true
```

To change or disable this exclusion, adjust `nfd:excludeNodeLabel` in your stack config.

## Uninstall

To uninstall NFD and clean up its custom resource definitions:

```sh
pulumi config set nfd:enabled false
pulumi up

kubectl delete crd \
  nodefeaturegroups.nfd.k8s-sigs.io \
  nodefeaturerules.nfd.k8s-sigs.io \
  nodefeatures.nfd.k8s-sigs.io
```
