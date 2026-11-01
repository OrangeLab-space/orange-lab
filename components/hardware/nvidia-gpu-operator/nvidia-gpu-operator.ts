import { Application, config } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

export class NvidiaGPUOperator extends pulumi.ComponentResource {
    private readonly app: Application;

    constructor(name: string, args = {}, opts?: pulumi.ResourceOptions) {
        super('orangelab:hardware:NvidiaGPUOperator', name, args, opts);

        if (config.getBoolean('nfd', 'gpu-autodetect')) {
            config.requireEnabled(name, 'nfd');
        }

        this.app = new Application(this, name);

        this.app.addHelmChart(
            name,
            {
                chart: 'gpu-operator',
                repo: 'https://helm.ngc.nvidia.com/nvidia',
                values: {
                    // NVIDIA Confidential Computing Manager for Kubernetes
                    ccManager: { enabled: false },
                    cdi: { enabled: true, nriPluginEnabled: true },
                    // Setting this list replaces the chart default, so keep the
                    // nvidia.com/gpu entry alongside our tolerations.
                    daemonsets: {
                        tolerations: [
                            {
                                key: 'nvidia.com/gpu',
                                operator: 'Exists',
                                effect: 'NoSchedule',
                            },
                            ...(this.app.nodes.getTolerations() ?? []),
                        ],
                    },
                    // NVidia Data Center GPU Manager - https://docs.nvidia.com/datacenter/dcgm/latest/user-guide/index.html
                    dcgm: { enabled: false },
                    dcgmExporter: { enabled: false },
                    // https://github.com/NVIDIA/k8s-device-plugin
                    devicePlugin: {
                        enabled: true,
                        config: {
                            create: true,
                            name: 'device-plugin-config',
                            default: 'default',
                            data: {
                                default: JSON.stringify({
                                    version: 'v1',
                                    flags: {
                                        migStrategy: 'none',
                                    },
                                    sharing: {
                                        timeSlicing: {
                                            resources: [
                                                {
                                                    name: 'nvidia.com/gpu',
                                                    replicas: 4,
                                                },
                                            ],
                                        },
                                    },
                                }),
                            },
                        },
                    },
                    // NVidia driver already installed on host
                    driver: {
                        enabled: false,
                        nodeSelector: { 'orangelab/gpu-nvidia': 'true' },
                    },
                    gdrcopy: { enabled: false },
                    // GPUDirect Storage kernel driver - https://github.com/NVIDIA/gds-nvidia-fs
                    gds: { enabled: false },
                    // GPU Feature Discovery
                    gfd: { enabled: true },
                    kataManager: { enabled: false },
                    migManager: { enabled: false },
                    // Node Feature Discovery dependent chart
                    nfd: { enabled: false },
                    nodeStatusExporter: { enabled: false },
                    operator: { defaultRuntime: 'containerd' },
                    sandboxDevicePlugin: { enabled: false },
                    // NVidia container toolkit
                    toolkit: { enabled: true },
                    vfioManager: { enabled: false },
                    // https://github.com/NVIDIA/vgpu-device-manager
                    vgpuDeviceManager: { enabled: false },
                    vgpuManager: { enabled: false },
                },
            },
            { deleteBeforeReplace: true },
        );
    }
}
