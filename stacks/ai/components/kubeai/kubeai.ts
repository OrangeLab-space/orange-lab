import { Application, GrafanaDashboard, config } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import dashboardJson from './kubeai-dashboard-vllm.json';

export class KubeAi extends pulumi.ComponentResource {
    public readonly endpointUrl?: pulumi.Input<string>;
    public readonly serviceUrl: string | undefined;

    private readonly app: Application;

    constructor(
        private name: string,
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:ai:KubeAi', name, {}, opts);

        const hostname = config.require(name, 'hostname');
        const huggingfaceToken = config.getSecret(name, 'huggingfaceToken');
        const models = config.getCommaSeparated(name, 'models') ?? [];

        this.app = new Application(this, name);
        const httpEndpointInfo = this.app.network.getHttpEndpointInfo();
        const kubeAi = this.app.addHelmChart(name, {
            chart: 'kubeai',
            repo: 'https://www.kubeai.org',
            values: {
                affinity: this.app.nodes.getAffinity(),
                ingress: {
                    enabled: true,
                    className: httpEndpointInfo.className,
                    rules: [
                        {
                            host: httpEndpointInfo.hostname,
                            paths: [{ path: '/', pathType: 'ImplementationSpecific' }],
                        },
                    ],
                    tls: [{ hosts: [httpEndpointInfo.hostname] }],
                },
                metrics: config.enableMonitoring()
                    ? {
                          prometheusOperator: {
                              vLLMPodMonitor: {
                                  enabled: true,
                                  labels: {},
                              },
                          },
                      }
                    : undefined,
                modelServers: {
                    OLlama: {
                        images: {
                            'amd-gpu': 'ollama/ollama:rocm',
                        },
                    },
                },
                modelAutoscaling: { timeWindow: '30m' },
                modelServerPods: {
                    // required for NVidia detection
                    securityContext: {
                        privileged: true,
                        allowPrivilegeEscalation: true,
                    },
                },
                ['open-webui']: { enabled: false },
                resourceProfiles: {
                    nvidia: {
                        nodeSelector: { 'orangelab/gpu-nvidia': 'true' },
                    },
                    amd: {
                        imageName: 'amd-gpu',
                        nodeSelector: { 'orangelab/gpu-amd': 'true' },
                        limits: { 'amd.com/gpu': 1 },
                    },
                },
                secrets: { huggingface: { token: huggingfaceToken } },
            },
        });

        this.app.addHelmChart(
            `${name}-models`,
            {
                chart: 'models',
                repo: 'https://www.kubeai.org',
                values: { catalog: this.createModelCatalog(models) },
            },
            { dependsOn: [kubeAi] },
        );

        if (config.enableMonitoring()) {
            new GrafanaDashboard(name, { configJson: dashboardJson }, { parent: this });
        }

        this.endpointUrl = httpEndpointInfo.url;
        this.serviceUrl = `http://${hostname}.kubeai/openai/v1`;
    }

    private createModelCatalog(models: string[]): Record<string, object> {
        const gfxVersion = config.get(this.name, 'HSA_OVERRIDE_GFX_VERSION');
        const amdTargets = config.get(this.name, 'HCC_AMDGPU_TARGETS');
        const modelProfiles = new Map<string, object>();
        modelProfiles.set('amd', {
            enabled: true,
            resourceProfile: 'amd:1',
            minReplicas: 0,
            env: {
                HSA_OVERRIDE_GFX_VERSION: gfxVersion,
                ...(amdTargets ? { HCC_AMDGPU_TARGETS: amdTargets } : {}),
            },
        });
        modelProfiles.set('nvidia', {
            enabled: true,
            resourceProfile: 'nvidia:1',
            minReplicas: 0,
        });
        const modelList = models.map(model => {
            const [modelName, profile, minReplicas = 0] = model.split('/');
            const info = { ...modelProfiles.get(profile || 'nvidia'), minReplicas };
            return { [modelName]: info };
        });
        const catalog = Object.assign({}, ...modelList) as Record<string, object>;
        return catalog;
    }
}
