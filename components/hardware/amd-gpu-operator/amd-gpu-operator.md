# AMD GPU operator

|                  |                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------- |
| Homepage         | https://github.com/ROCm/gpu-operator                                                |
| Docs             | https://instinct.docs.amd.com/projects/gpu-operator                                 |
| Helm values      | https://github.com/ROCm/gpu-operator/blob/main/helm-charts/values.yaml              |
| DeviceConfig ref | https://instinct.docs.amd.com/projects/gpu-operator/en/latest/fulldeviceconfig.html |

This component is needed to run GPU workloads using AMD devices with ROCm support.

## Installation

```sh
# Enable automatic GPU detection with NFD
pulumi config set nfd:enabled true
pulumi config set nfd:gpu-autodetect true # default
pulumi up

# Check if nodes are properly labeled:
kubectl get nodes --selector=orangelab/gpu-amd=true

# Install cert-manager
pulumi config set cert-manager:enabled true
pulumi up

# Enable AMD GPU operator
pulumi config set amd-gpu-operator:enabled true
pulumi up
```

## Using AMD GPUs with Applications

### Ollama

```sh
pulumi config set ollama:enabled true
# Switch to ROCm image
pulumi config set ollama:gpu amd
pulumi up
```

#### AMD GPU Configuration Overrides

For certain AMD GPUs, you may need to override configuration settings if not properly detected:

```sh
# Example for Radeon 780M
pulumi config set ollama:HSA_OVERRIDE_GFX_VERSION "11.0.0"
pulumi config set ollama:HCC_AMDGPU_TARGETS "gfx1103"
pulumi up
```

The `HSA_OVERRIDE_GFX_VERSION` setting can help with ROCm compatibility, while `HCC_AMDGPU_TARGETS` specifies the architecture target for ROCm applications.

More information at https://github.com/ollama/ollama/blob/main/docs/gpu.md#overrides-on-linux

## Monitoring

AMD GPU dashboards and metrics for Prometheus are automatically installed when component monitoring is enabled:

- AMD - Overview
- AMD - GPU
- AMD - Job
- AMD - Compute Node

The metrics exporter image can be customized with `amd-gpu-operator:metricsExporter/image` (default `docker.io/rocm/device-metrics-exporter:v1.5.3`).

```sh
pulumi config set prometheus:enableComponentMonitoring true
pulumi up
```

## Uninstall

For detailed uninstallation instructions, see the [official documentation](https://instinct.docs.amd.com/projects/gpu-operator/en/latest/uninstallation/uninstallation.html).

```sh
pulumi config set amd-gpu-operator:enabled false
pulumi up

kubectl delete crds deviceconfigs.amd.com \
    modules.kmm.sigs.x-k8s.io \
    nodemodulesconfigs.kmm.sigs.x-k8s.io \
    preflightvalidations.kmm.sigs.x-k8s.io
```
