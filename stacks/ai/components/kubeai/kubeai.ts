import {
    Application,
    GrafanaDashboard,
    HttpEndpointInfo,
    config,
} from '@orangelab/pulumi';
import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import dashboardJson from './kubeai-dashboard-vllm.json';
import {
    ModelImages,
    ModelNodeSpec,
    modelEngineKeys,
    modelEngineNames,
    nodeResourceProfile,
    parseModelDefinitions,
    parseModelImages,
    parseModelNodes,
} from './model-config';
import {
    createModelLoaders,
    createModelResources,
    createModelVolumes,
} from './model-resources';

export class KubeAi extends pulumi.ComponentResource {
    public readonly app: Application;

    constructor(
        private name: string,
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:ai:KubeAi', name, {}, opts);

        config.assertNotConfigured(
            name,
            'models',
            `${name}:models was removed. Move catalog models to ${name}:modelDefinitions and ${name}:modelNodes.`,
        );
        for (const engine of modelEngineKeys) {
            config.assertNotConfigured(
                name,
                `${engine}/image`,
                `${name}:${engine}/image was removed. Use ${name}:images.${engine}.<gpu> instead (amd|nvidia).`,
            );
        }

        const hostname = config.require(name, 'hostname');
        const huggingfaceToken = config.getSecret(name, 'huggingfaceToken');
        const images = parseModelImages(name);

        this.app = new Application(this, name);
        const tolerations = this.app.nodes.getTolerations();
        const httpEndpointInfo = this.app.network.getHttpEndpointInfo();
        const nodes = parseModelNodes(name);
        const definitions = parseModelDefinitions(name, nodes);

        const chart = this.app.addHelmChart(name, {
            chart: 'kubeai',
            repo: 'https://www.kubeai.org',
            values: this.createHelmValues(
                httpEndpointInfo,
                huggingfaceToken,
                nodes,
                images,
                tolerations,
            ),
        });

        const storagePath = config.require(name, 'modelStoragePath');
        const resourceArgs = {
            appName: name,
            chart,
            namespace: this.app.metadata.namespace,
            parent: this,
            storagePath,
        };
        const volumes = createModelVolumes({ ...resourceArgs, nodes });
        const loaders = createModelLoaders({
            ...resourceArgs,
            definitions,
            nodes,
            ollamaImages: images.ollama ?? {},
            tolerations,
        });
        createModelResources({
            ...resourceArgs,
            definitions,
            loaders,
            nodes,
            volumes,
        });

        if (config.enableMonitoring()) {
            new GrafanaDashboard(name, { configJson: dashboardJson }, { parent: this });
        }

        const serviceUrl = pulumi.interpolate`http://${hostname}.kubeai/openai/v1`;
        this.app.network.addEndpoint(name, httpEndpointInfo.url);
        this.app.network.addClusterEndpoint(name, serviceUrl);
    }

    private createHelmValues(
        httpEndpointInfo: HttpEndpointInfo,
        huggingfaceToken: pulumi.Input<string> | undefined,
        nodes: Map<string, ModelNodeSpec>,
        images: ModelImages,
        tolerations: kubernetes.types.input.core.v1.Toleration[] | undefined,
    ): pulumi.Inputs {
        return {
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
                          llamaCppPodMonitor: {
                              enabled: true,
                              labels: {},
                          },
                      },
                  }
                : undefined,
            modelAutoscaling: { timeWindow: '30m' },
            // Single-GPU nodes cannot schedule a surge pod while the old
            // model pod still holds the GPU.
            modelRollouts: { surge: 0 },
            modelServerPods: {
                securityContext: {
                    allowPrivilegeEscalation: false,
                    capabilities: { drop: ['ALL'] },
                    readOnlyRootFilesystem: false,
                    runAsGroup: 0,
                    runAsUser: 0,
                    seLinuxOptions: { type: 'spc_t' },
                },
            },
            modelServers: this.createModelServers(images),
            nodeSelector: { 'orangelab/gpu-amd': 'true' },
            ['open-webui']: { enabled: false },
            resourceProfiles: Object.fromEntries(
                [...nodes.values()].map((node): [string, object] => [
                    nodeResourceProfile(node),
                    {
                        imageName: `${node.gpu}-gpu`,
                        limits: { [`${node.gpu}.com/gpu`]: 1 },
                        nodeSelector: { 'kubernetes.io/hostname': node.name },
                        ...(tolerations ? { tolerations } : {}),
                    },
                ]),
            ),
            secrets: { huggingface: { token: huggingfaceToken } },
            tolerations,
        };
    }

    private createModelServers(images: ModelImages): Record<string, object> {
        const servers: Record<string, object> = {};
        for (const engine of modelEngineKeys) {
            const engineImages = images[engine];
            if (!engineImages) continue;
            servers[modelEngineNames[engine]] = {
                images: Object.fromEntries(
                    Object.entries(engineImages).map(([gpu, image]) => [
                        `${gpu}-gpu`,
                        image,
                    ]),
                ),
            };
        }
        return servers;
    }
}
