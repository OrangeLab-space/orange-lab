import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { config } from './config';
import { InitContainers } from './containers-init';
import { Metadata } from './metadata';
import { Nodes } from './nodes';
import { Storage, resolveVolumeName } from './storage';
import {
    ContainerResources,
    ContainerSpec,
    GpuType,
    HealthCheck,
    ServicePort,
    VolumeMount,
} from './types';

export class Containers {
    private initContainers: InitContainers;

    constructor(
        private appName: string,
        private args: {
            metadata: Metadata;
            serviceAccount?: kubernetes.core.v1.ServiceAccount;
            storage?: Storage;
            nodes: Nodes;
        },
        private opts?: pulumi.ComponentResourceOptions,
    ) {
        this.initContainers = new InitContainers(appName, args, opts);
    }

    public createPodTemplateSpec(
        spec: ContainerSpec,
    ): kubernetes.types.input.core.v1.PodTemplateSpec {
        const gpu = this.args.nodes.getGpu(spec.name);
        const metadata = this.args.metadata.get({
            component: spec.name,
            annotations: this.args.storage?.configFilesHash
                ? { 'checksum/config': this.args.storage.configFilesHash }
                : undefined,
        });
        const image =
            spec.image ??
            (spec.name
                ? config.require(this.appName, `${spec.name}/image`)
                : config.require(this.appName, 'image'));
        const volumeMounts = this.createVolumeMounts(spec.volumeMounts, gpu);
        const volumeNames = [
            ...volumeMounts.map(mount => mount.name),
            ...this.initContainers.getVolumeNames(spec),
        ];
        const volumes = this.createVolumes(volumeNames, gpu);
        return {
            metadata,
            spec: {
                affinity: this.args.nodes.getAffinity(spec.name),
                containers: [
                    {
                        args: spec.commandArgs
                            ? pulumi
                                  .output(spec.commandArgs)
                                  .apply(args => args.filter(Boolean))
                            : undefined,
                        command: spec.command,
                        env: this.createEnv(spec.env, gpu),
                        envFrom: this.createEnvSecret({
                            containerName: spec.name,
                            secretData: spec.envSecret,
                        }),
                        image,
                        livenessProbe: this.createProbe(spec.healthCheck),
                        name: metadata.name,
                        ports: this.createPorts(spec.ports),
                        readinessProbe: this.createProbe(spec.healthCheck),
                        resources: this.createResourceLimits(spec.resources, gpu),
                        securityContext: this.createContainerSecurityContext(
                            spec.runAsUser,
                            gpu,
                        ),
                        startupProbe: this.createProbe(spec.healthCheck, {
                            failureThreshold: 10,
                        }),
                        volumeMounts,
                    },
                ],
                dnsPolicy: spec.hostNetwork ? 'ClusterFirstWithHostNet' : undefined,
                hostNetwork: spec.hostNetwork,
                hostname: spec.hostname,
                initContainers: this.initContainers.create(spec),
                restartPolicy: spec.restartPolicy,
                securityContext: this.args.storage?.hasLocal()
                    ? { seLinuxOptions: { type: 'spc_t' } }
                    : undefined,
                serviceAccountName: spec.serviceAccountName ??
                    this.args.serviceAccount?.metadata.name,
                volumes,
            },
        };
    }

    private createContainerSecurityContext(
        runAsUser?: number,
        gpu?: GpuType,
    ): kubernetes.types.input.core.v1.SecurityContext | undefined {
        const context: kubernetes.types.input.core.v1.SecurityContext = {};
        if (gpu === 'amd') {
            context.seccompProfile = { type: 'Unconfined' };
        }
        if (this.args.storage?.hasDeviceMounts()) {
            context.privileged = true;
        }
        if (runAsUser) {
            context.runAsUser = runAsUser;
            context.runAsGroup = runAsUser;
        }
        return Object.keys(context).length ? context : undefined;
    }

    private createPorts(ports: ServicePort[] = []) {
        return ports.map(port => ({
            name: port.name,
            containerPort: port.port,
            protocol: port.protocol === 'udp' ? 'UDP' : 'TCP',
        }));
    }

    private createVolumes(
        volumeNames: (pulumi.Input<string> | undefined)[],
        gpu?: GpuType,
    ): kubernetes.types.input.core.v1.Volume[] | undefined {
        if (gpu === 'amd') {
            this.args.storage?.addDeviceMount({
                name: 'dev-kfd',
                hostPath: '/dev/kfd',
            });
            this.args.storage?.addDeviceMount({
                name: 'dev-dri',
                hostPath: '/dev/dri',
                type: 'Directory',
            });
        }
        const volumes = (this.args.storage?.getVolumes() ?? []).filter(vol =>
            volumeNames.includes(vol.name),
        );
        return volumes.length ? volumes : undefined;
    }

    private createVolumeMounts(
        volumeMounts?: VolumeMount[],
        gpu?: GpuType,
    ): kubernetes.types.input.core.v1.VolumeMount[] {
        const mounts = (volumeMounts ?? []).map(volumeMount => ({
            ...volumeMount,
            ...{ name: resolveVolumeName(this.appName, volumeMount.name) },
        }));
        if (gpu === 'amd') {
            mounts.push({ name: 'dev-kfd', mountPath: '/dev/kfd' });
            mounts.push({ name: 'dev-dri', mountPath: '/dev/dri' });
        }
        return mounts;
    }

    private createResourceLimits(
        resources?: ContainerResources,
        gpu?: GpuType,
    ): kubernetes.types.input.core.v1.ResourceRequirements | undefined {
        switch (gpu) {
            case 'nvidia':
                return {
                    ...resources,
                    limits: { ...resources?.limits, 'nvidia.com/gpu': '1' },
                };
            // AMD does not support time slicing
            // Volumes used for direct device access instead of resource limits
            default:
                return resources;
        }
    }

    private createProbe(
        probe?: HealthCheck,
        override?: Partial<kubernetes.types.input.core.v1.Probe>,
    ): kubernetes.types.input.core.v1.Probe | undefined {
        if (!probe) return undefined;
        const result: Record<string, unknown> = {
            failureThreshold: probe.failureThreshold,
            httpGet: probe.httpGet ? { ...probe.httpGet, port: 'http' } : undefined,
        };
        if (override) {
            Object.assign(result, override);
        }
        return result;
    }

    private createEnv(
        specEnv?: Record<string, pulumi.Input<string> | undefined>,
        gpu?: GpuType,
    ) {
        const gfxVersion = config.get(this.appName, 'HSA_OVERRIDE_GFX_VERSION');
        const amdTargets = config.get(this.appName, 'HCC_AMDGPU_TARGETS');
        const hipDevices = config.get(this.appName, 'HIP_VISIBLE_DEVICES');
        const rocrDevices = config.get(this.appName, 'ROCR_VISIBLE_DEVICES');
        const cudaDevices = config.get(this.appName, 'CUDA_VISIBLE_DEVICES');
        const env = {
            ...specEnv,
            HSA_OVERRIDE_GFX_VERSION:
                gpu === 'amd' && gfxVersion ? gfxVersion : undefined,
            HCC_AMDGPU_TARGETS: gpu === 'amd' && amdTargets ? amdTargets : undefined,
            HIP_VISIBLE_DEVICES: gpu === 'amd' && hipDevices ? hipDevices : undefined,
            ROCR_VISIBLE_DEVICES: gpu === 'amd' && rocrDevices ? rocrDevices : undefined,
            CUDA_VISIBLE_DEVICES:
                gpu === 'nvidia' && cudaDevices ? cudaDevices : undefined,
        };
        return Object.entries(env)
            .filter(([_, value]) => value)
            .map(([key, value]) => ({ name: key, value }));
    }

    private createEnvSecret(args: {
        containerName?: string;
        secretData?: Record<string, pulumi.Input<string> | undefined>;
    }) {
        if (!args.secretData) return;
        const metadata = this.args.metadata.get({ component: args.containerName });
        const secret = new kubernetes.core.v1.Secret(
            `${metadata.name}-env`,
            {
                metadata: {
                    ...metadata,
                    name: `${metadata.name}-env`,
                },
                immutable: true,
                // filter out undefined values
                stringData: Object.fromEntries(
                    Object.entries(args.secretData)
                        .filter(([_, v]) => v !== undefined)
                        .map(([k, v]) => [k, pulumi.output(v).apply(String)]),
                ),
            },
            this.opts,
        );
        return [{ secretRef: { name: secret.metadata.name } }];
    }
}
