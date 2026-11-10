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
    SidecarSpec,
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
        const image = spec.image ?? config.getImage(this.appName, gpu, spec.name);
        const sidecars = spec.sidecars ?? [];
        const volumeMounts = this.createVolumeMounts(spec.volumeMounts, gpu);
        const sidecarVolumeMounts = sidecars.flatMap(sidecar =>
            this.createVolumeMounts(sidecar.volumeMounts),
        );
        const volumeNames = [
            ...volumeMounts.map(mount => mount.name),
            ...sidecarVolumeMounts.map(mount => mount.name),
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
                        imagePullPolicy: config.getImagePullPolicy(this.appName),
                        livenessProbe: this.createProbe(spec.healthCheck),
                        name: metadata.name,
                        ports: this.createPorts(spec.ports),
                        readinessProbe: this.createReadinessProbe(spec.healthCheck),
                        resources: this.createResourceLimits(spec.resources, gpu),
                        securityContext: this.createContainerSecurityContext(
                            spec.runAsUser,
                            gpu,
                        ),
                        startupProbe: this.createProbe(spec.healthCheck, {
                            failureThreshold:
                                spec.healthCheck?.startupFailureThreshold ?? 10,
                        }),
                        volumeMounts,
                    },
                    ...sidecars.map(sidecar => this.createSidecarContainer(sidecar)),
                ],
                dnsPolicy: spec.hostNetwork ? 'ClusterFirstWithHostNet' : undefined,
                hostNetwork: spec.hostNetwork,
                hostname: spec.hostname,
                initContainers: this.initContainers.create(spec),
                nodeSelector: spec.nodeSelector,
                restartPolicy: spec.restartPolicy,
                securityContext: this.args.storage?.hasLocal()
                    ? { seLinuxOptions: { type: 'spc_t' } }
                    : undefined,
                serviceAccountName: spec.serviceAccountName ??
                    this.args.serviceAccount?.metadata.name,
                tolerations: this.args.nodes.getTolerations(spec.name),
                volumes,
            },
        };
    }

    /**
     * The default every application container starts from: no way to gain
     * privileges, the default seccomp profile, and only the capabilities needed to
     * chown a data directory and, as root, bind a low port. NET_RAW, MKNOD,
     * SETPCAP and SYS_CHROOT are gone, so a compromised process has to find a
     * kernel bug rather than a capability.
     *
     * Device passthrough is the one exception: it needs privileged, and privileged
     * ignores every other field in this context.
     */
    private createContainerSecurityContext(
        runAsUser?: number,
        gpu?: GpuType,
    ): kubernetes.types.input.core.v1.SecurityContext | undefined {
        if (this.args.storage?.hasDeviceMounts()) {
            return runAsUser
                ? { privileged: true, runAsUser, runAsGroup: runAsUser }
                : { privileged: true };
        }
        const context: kubernetes.types.input.core.v1.SecurityContext = {
            allowPrivilegeEscalation: false,
            capabilities: {
                drop: ['ALL'],
                add: [
                    'CHOWN',
                    'DAC_OVERRIDE',
                    'FOWNER',
                    'SETGID',
                    'SETUID',
                    'NET_BIND_SERVICE',
                ],
            },
            // The AMD driver rejects the default profile.
            seccompProfile: { type: gpu === 'amd' ? 'Unconfined' : 'RuntimeDefault' },
        };
        if (runAsUser) {
            context.runAsUser = runAsUser;
            context.runAsGroup = runAsUser;
        }
        return context;
    }

    private createSidecarContainer(
        sidecar: SidecarSpec,
    ): kubernetes.types.input.core.v1.Container {
        return {
            ...this.createSidecarProbes(sidecar.healthCheck),
            args: sidecar.commandArgs
                ? pulumi.output(sidecar.commandArgs).apply(args => args.filter(Boolean))
                : undefined,
            command: sidecar.command,
            env: this.createSidecarEnv(sidecar.env),
            envFrom: this.createEnvSecret({
                containerName: sidecar.name,
                secretData: sidecar.envSecret,
            }),
            image: sidecar.image,
            imagePullPolicy: config.getImagePullPolicy(this.appName),
            name: sidecar.name,
            resources: sidecar.resources,
            securityContext: this.createSidecarSecurityContext(
                sidecar.runAsUser,
                sidecar.runAsGroup,
            ),
            volumeMounts: this.createVolumeMounts(sidecar.volumeMounts),
        };
    }

    /**
     * Sidecars get startup and liveness probes only. A readiness probe would take
     * the whole pod out of its Service when a helper misbehaves, so readiness
     * stays with the main container.
     */
    private createSidecarProbes(healthCheck?: HealthCheck) {
        return {
            livenessProbe: this.createProbe(healthCheck, {
                failureThreshold: 3,
                periodSeconds: 30,
                timeoutSeconds: 5,
            }),
            startupProbe: this.createProbe(healthCheck, {
                failureThreshold: 30,
                periodSeconds: 2,
            }),
        };
    }

    private createSidecarEnv(
        env?: Record<string, pulumi.Input<string> | undefined>,
    ): { name: string; value: pulumi.Input<string> }[] | undefined {
        if (!env) return undefined;
        const entries: { name: string; value: pulumi.Input<string> }[] = [];
        for (const [name, value] of Object.entries(env)) {
            if (value !== undefined) entries.push({ name, value });
        }
        return entries.length ? entries : undefined;
    }

    /** Sidecars run beside the app, so they start from the same hardened profile. */
    private createSidecarSecurityContext(
        runAsUser?: number,
        runAsGroup?: number,
    ): kubernetes.types.input.core.v1.SecurityContext | undefined {
        return {
            ...this.createContainerSecurityContext(runAsUser),
            ...(runAsUser === undefined ? {} : { runAsGroup: runAsGroup ?? runAsUser }),
        };
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
        }
        if (gpu === 'amd' || gpu === 'intel') {
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
        }
        if (gpu === 'amd' || gpu === 'intel') {
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
            exec: probe.exec,
            failureThreshold: probe.failureThreshold,
            httpGet: probe.httpGet
                ? { ...probe.httpGet, port: probe.httpGet.port ?? 'http' }
                : undefined,
        };
        if (override) {
            Object.assign(result, override);
        }
        return result;
    }

    /**
     * Readiness is the only probe allowed to report on a different path: a
     * service that is up but cannot serve must leave the Service endpoints
     * without being restarted, which is what liveness and startup would do.
     */
    private createReadinessProbe(
        probe?: HealthCheck,
    ): kubernetes.types.input.core.v1.Probe | undefined {
        if (!probe?.readinessPath || !probe.httpGet) return this.createProbe(probe);
        return this.createProbe({
            ...probe,
            httpGet: { ...probe.httpGet, path: probe.readinessPath },
        });
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
