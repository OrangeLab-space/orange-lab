import {
    Application,
    GrafanaDashboard,
    HttpEndpointInfo,
    config,
} from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import dashboardJson from './kubeai-dashboard-vllm.json';
import {
    ModelNodeSpec,
    nodeResourceProfile,
    parseModelDefinitions,
    parseModelNodes,
} from './model-config';
import {
    createModelLoaders,
    createModelResources,
    createModelVolumes,
} from './model-resources';

interface ModelImages {
    llamacpp?: string;
    ollama: string;
    vllm?: string;
}

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

        const hostname = config.require(name, 'hostname');
        const huggingfaceToken = config.getSecret(name, 'huggingfaceToken');
        const modelImages: ModelImages = {
            llamacpp: config.get(name, 'llamacpp/image'),
            ollama: config.require(name, 'ollama/image'),
            vllm: config.get(name, 'vllm/image'),
        };

        this.app = new Application(this, name);
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
                modelImages,
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
            ollamaImage: modelImages.ollama,
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
        modelImages: ModelImages,
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
                },
            },
            modelServers: this.createModelServers(modelImages),
            nodeSelector: { 'orangelab/gpu-amd': 'true' },
            ['open-webui']: { enabled: false },
            resourceProfiles: Object.fromEntries(
                [...nodes.values()].map((node): [string, object] => [
                    nodeResourceProfile(node.name),
                    {
                        imageName: 'amd-gpu',
                        limits: { 'amd.com/gpu': 1 },
                        nodeSelector: { 'kubernetes.io/hostname': node.name },
                    },
                ]),
            ),
            secrets: { huggingface: { token: huggingfaceToken } },
        };
    }

    private createModelServers(images: ModelImages): Record<string, object> {
        const servers: Record<string, object> = {
            OLlama: { images: { 'amd-gpu': images.ollama } },
        };
        if (images.llamacpp) {
            servers.LlamaCpp = { images: { 'amd-gpu': images.llamacpp } };
        }
        if (images.vllm) servers.VLLM = { images: { 'amd-gpu': images.vllm } };
        return servers;
    }
}
