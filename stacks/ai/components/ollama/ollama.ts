import { Application, config, HttpEndpointInfo } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

export class Ollama extends pulumi.ComponentResource {
    public readonly endpointUrl?: pulumi.Input<string>;
    public readonly serviceUrl?: string;

    private readonly app: Application;

    constructor(
        private name: string,
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:ai:Ollama', name, {}, opts);

        const hostname = config.require(name, 'hostname');

        this.app = new Application(this, name).addStorage();

        if (this.app.storageOnly) return;

        const httpEndpointInfo = this.app.network.getHttpEndpointInfo();
        this.createHelmRelease(httpEndpointInfo);

        this.endpointUrl = httpEndpointInfo.url;
        this.serviceUrl = `http://${hostname}.ollama:11434`;
    }

    private createHelmRelease(httpEndpointInfo: HttpEndpointInfo) {
        const gpu = this.app.nodes.getGpu();
        const gfxVersion = config.get(this.name, 'HSA_OVERRIDE_GFX_VERSION');
        const amdTargets = config.get(this.name, 'HCC_AMDGPU_TARGETS');
        const flashAttention = config.get(this.name, 'OLLAMA_FLASH_ATTENTION');
        const kvCacheType = config.get(this.name, 'OLLAMA_KV_CACHE_TYPE');
        const igpuEnable = config.get(this.name, 'OLLAMA_IGPU_ENABLE');
        const extraEnv = [
            { name: 'OLLAMA_DEBUG', value: this.app.debug ? 'true' : 'false' },
            {
                name: 'OLLAMA_KEEP_ALIVE',
                value: config.require(this.name, 'OLLAMA_KEEP_ALIVE'),
            },
            { name: 'OLLAMA_LOAD_TIMEOUT', value: '5m' },
            {
                name: 'OLLAMA_CONTEXT_LENGTH',
                value: config.require(this.name, 'OLLAMA_CONTEXT_LENGTH'),
            },
        ];
        if (flashAttention) {
            extraEnv.push({
                name: 'OLLAMA_FLASH_ATTENTION',
                value: flashAttention,
            });
        }
        if (kvCacheType) {
            extraEnv.push({
                name: 'OLLAMA_KV_CACHE_TYPE',
                value: kvCacheType,
            });
        }
        if (igpuEnable) {
            extraEnv.push({
                name: 'OLLAMA_IGPU_ENABLE',
                value: igpuEnable,
            });
        }
        if (gpu === 'amd' && gfxVersion) {
            extraEnv.push({
                name: 'HSA_OVERRIDE_GFX_VERSION',
                value: gfxVersion,
            });
        }
        if (gpu === 'amd' && amdTargets) {
            extraEnv.push({
                name: 'HCC_AMDGPU_TARGETS',
                value: amdTargets,
            });
        }
        let imageTag = config.get(this.name, 'appVersion');
        if (gpu === 'amd' && imageTag) imageTag = imageTag.concat('-rocm');

        const deviceVolumes: { name: string; hostPath: { path: string } }[] = [];
        const deviceVolumeMounts: { name: string; mountPath: string }[] = [];
        if (gpu === 'amd') {
            deviceVolumes.push({ name: 'kfd', hostPath: { path: '/dev/kfd' } });
            deviceVolumeMounts.push({ name: 'kfd', mountPath: '/dev/kfd' });
        }
        if (gpu === 'amd' || gpu === 'intel') {
            deviceVolumes.push({ name: 'dri', hostPath: { path: '/dev/dri' } });
            deviceVolumeMounts.push({ name: 'dri', mountPath: '/dev/dri' });
        }

        this.app.addHelmChart(
            this.name,
            {
                chart: 'ollama',
                repo: 'https://otwld.github.io/ollama-helm/',
                values: {
                    affinity: this.app.nodes.getAffinity(),
                    extraEnv,
                    fullnameOverride: 'ollama',
                    image: { tag: imageTag },
                    ingress: {
                        enabled: true,
                        className: httpEndpointInfo.className,
                        hosts: [
                            {
                                host: httpEndpointInfo.hostname,
                                paths: [{ path: '/', pathType: 'Prefix' }],
                            },
                        ],
                        tls: [
                            {
                                hosts: [httpEndpointInfo.hostname],
                                secretName: httpEndpointInfo.tlsSecretName,
                            },
                        ],
                    },
                    ollama: {
                        gpu: {
                            // CPU-only mode: no GPU resources requested
                            // AMD: device volumes used instead of resource requests
                            // NVIDIA: standard GPU resource requests
                            enabled: gpu ? true : false,
                            type: gpu ?? undefined,
                            number: 1,
                        },
                        models: {
                            run: config.getCommaSeparated(this.name, 'models') ?? [],
                        },
                    },
                    ...(deviceVolumes.length
                        ? {
                              volumes: deviceVolumes,
                              volumeMounts: deviceVolumeMounts,
                          }
                        : {}),
                    persistentVolume: {
                        enabled: true,
                        existingClaim: this.app.storage?.getClaimName(),
                    },
                    replicaCount: 1,
                    securityContext:
                        gpu === 'amd' || gpu === 'intel'
                            ? { privileged: true }
                            : undefined,
                },
            },
            { dependsOn: this.app.storage },
        );
    }
}
