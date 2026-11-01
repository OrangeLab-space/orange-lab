# NVIDIA GPU operator

|            |                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| Homepage   | https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/                                                           |
| Helm chart | https://github.com/NVIDIA/gpu-operator/blob/main/deployments/gpu-operator/                                              |
| Components | https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/platform-support.html#gpu-operator-component-matrix |

This component is needed to run GPU workloads using NVidia devices.

Enable the NVIDIA GPU operator to support NVIDIA GPU workloads.

```sh
# Enable automatic GPU detection with NFD
pulumi config set nfd:enabled true

# Enable NVIDIA GPU operator
pulumi config set nvidia-gpu-operator:enabled true

pulumi up

```

## Tainted nodes

On a tainted GPU node, give the GPU operands a toleration so they can run:

```sh
pulumi config set nvidia-gpu-operator:tolerations orangelab/dedicated:NoSchedule
```
