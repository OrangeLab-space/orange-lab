import * as pulumi from '@pulumi/pulumi';

export type GpuType = 'amd' | 'nvidia';

export type VolumeAccessMode = 'ReadWriteOnce' | 'ReadWriteMany';

export interface ServicePort {
    /**
     * The name of the port. Used to generate endpoint keys and URLs.
     * Use 'http' for the primary HTTP port to get clean URLs (e.g., https://app.tailnet)
     * instead of https://app-http.tailnet. Also required for health checks.
     */
    name: string;
    port: number;
    hostname?: string;
    /**
     * The protocol for this port. Defaults to 'http'.
     * - 'http': Standard HTTP endpoint (default, no explicit protocol needed)
     * - 'tcp': TCP endpoint via LoadBalancer
     * - 'tls': TLS-encrypted TCP endpoint via TLSRoute
     * - 'udp': UDP endpoint via LoadBalancer
     */
    protocol?: 'http' | 'tcp' | 'tls' | 'udp';
    private?: boolean;
}

export interface VolumeMount {
    mountPath: string;
    name?: string;
    subPath?: string;
    readOnly?: boolean;
}

export interface InitContainerSpec {
    name: string;
    /**
     * The Docker image to use for the init container.
     * Defaults to 'alpine:latest'.
     */
    image?: string;
    command?: pulumi.Input<string[]>;
    /**
     * Optional volume mounts for the init container.
     * If not provided, it will use the main container's volume mounts.
     */
    volumeMounts?: VolumeMount[];
}

/**
 * Represents the resource limits and requests for a container.
 */
export interface ContainerResources {
    limits?: {
        cpu?: string;
        memory?: string;
    };
    requests?: {
        cpu?: string;
        memory?: string;
    };
}

export interface HealthCheck {
    httpGet?: {
        path?: string;
    };
    failureThreshold?: number;
}

/**
 * Represents the specification for a container in a Kubernetes deployment.
 */
export interface ContainerSpec {
    name?: string;
    /**
     * Docker image (e.g., "nginx:latest").
     * If not provided, defaults to reading from config key `<app>:image`.
     */
    image?: string;
    ports?: ServicePort[];
    command?: pulumi.Input<string[]>;
    commandArgs?: pulumi.Input<string[]>;
    env?: Record<string, pulumi.Input<string> | undefined>;
    envSecret?: Record<string, pulumi.Input<string> | undefined>;
    externalTrafficPolicy?: 'Local' | 'Cluster';
    hostNetwork?: boolean;
    /**
     * If provided, the pod uses this existing ServiceAccount name
     * instead of creating a new one.
     */
    serviceAccountName?: pulumi.Input<string>;
    clusterIP?: string;
    initContainers?: InitContainerSpec[];
    volumeMounts?: VolumeMount[];
    healthCheck?: HealthCheck;
    resources?: ContainerResources;
    hostname?: string;
    runAsUser?: number;
    volumeOwnerUserId?: number;
    restartPolicy?: string;
}

/**
 * Represents a local volume using local-path provisioner or direct hostPath.
 * Use localPath for PV/PVC mode, or hostPath for direct hostPath mode.
 */
export interface LocalVolumeSpec {
    name: string;
    localPath?: string;
    hostPath?: string;
    size?: string;
    type?: 'Directory' | 'DirectoryOrCreate' | 'FileOrCreate' | 'CharDevice';
}

/**
 * Represents an emptyDir volume, optionally backed by memory.
 * Use `memory` for shared-memory or cache mounts (e.g. /dev/shm, /tmp/cache).
 */
export interface EmptyVolumeSpec {
    name: string;
    memory?: boolean;
    sizeLimit?: string;
}

/**
 * Represents a device mount (e.g., /dev/kfd, /dev/dri).
 * Used for GPU device access and similar hardware.
 */
export interface DeviceMountSpec {
    name: string;
    hostPath: string;
    type?: 'CharDevice' | 'Directory';
}

/**
 * Represents a persistent volume configuration for Longhorn.
 */

export interface PersistentVolumeSpec {
    /**
     * The optional name suffix for the volume.
     * If provided, the full volume name will be `${appName}-${name}`.
     * If not provided, the `appName` will be used as the volume name.
     * This name also acts as a prefix for configuration lookups (e.g., `<name>/storageSize`).
     */
    name?: string;
    /**
     * The desired size of the persistent volume (e.g., "10Gi", "100Mi").
     * If not provided, the value will be sourced from the Pulumi config key
     * `${name}/storageSize` or `storageSize` if `name` is not set.
     */
    size?: string;
    /**
     * Access mode for the volume. Defaults to 'ReadWriteOnce'.
     * Use 'ReadWriteMany' to share one Longhorn volume between multiple apps
     * (mounted via Longhorn share manager).
     */
    accessMode?: VolumeAccessMode;
    /**
     * Specifies an existing volume name to potentially restore data from.
     * This is typically used in conjunction with backup/restore mechanisms.
     * If not provided, the value might be sourced from the Pulumi config key
     * `${name}/fromVolume` or `fromVolume` if `name` is not set.
     */
    fromVolume?: string;
    /**
     * Allows explicitly setting the full name of the resulting PersistentVolumeClaim resource.
     * This is particularly useful for integration with StatefulSets using volume claim templates,
     * where Kubernetes automatically generates PVC names like `<volumeClaimTemplate.name>-<statefulSet.name>-<ordinalIndex>`.
     * If not provided, the name defaults to `${appName}-${name}` or just `appName`.
     * More info at https://longhorn.io/docs/1.8.1/snapshots-and-backups/backup-and-restore/restore-statefulset/
     */
    overrideFullname?: string;
    /**
     * Labels to apply to the PVC
     */
    labels?: Record<string, string>;
    /**
     * Annotations to apply to the PVC
     */
    annotations?: Record<string, string>;
    /**
     * Create a Kubernetes StorageClass matching the static Longhorn volume.
     * Kubernetes generally matches PV and PVC by StorageClass name
     * but some Helm charts (f.e. prometheus) need the StorageClass to exist.
     */
    createStorageClass?: boolean;
}

/**
 * Represents a volume that contains configuration files mounted in the same folder.
 * Either `files` or `secretFiles` must be provided, or both.
 */
export interface ConfigVolumeSpec {
    /**
     * The name of the config volume.
     * If not provided, defaults to 'config'.
     */
    name?: string;
    /**
     * A map of configuration files to their contents.
     * The keys are the file names, and the values are the file contents.
     * These are stored in a ConfigMap.
     */
    files?: Record<string, pulumi.Input<string>>;
    /**
     * A map of sensitive configuration files to their contents.
     * The keys are the file names, and the values are the file contents.
     * These are stored in a Secret for better security.
     */
    secretFiles?: Record<string, pulumi.Input<string>>;
}

/**
 * Represents the configuration needed to connect to a database instance.
 */
export interface DatabaseConfig {
    name: string;
    hostname: pulumi.Input<string>;
    database: pulumi.Input<string>;
    username: pulumi.Input<string>;
    password: pulumi.Input<string>;
    port: pulumi.Input<number>;
}

/**
 * Interface for S3 provisioner implementations (MinIO, RustFS, etc.)
 */
export interface S3Provisioner {
    create: (args: { username: string; bucket: string }) => {
        s3EndpointUrl: pulumi.Output<string>;
        accessKey: pulumi.Output<string>;
        secretKey: pulumi.Output<string>;
    };
    instanceName: string;
}

/**
 * Represents HTTP endpoint information for network routing.
 */
export interface HttpEndpointInfo {
    className: string;
    host: string;
    hostname: pulumi.Input<string>;
    url: pulumi.Input<string>;
    tls: boolean;
    tlsSecretName?: string;
    domain: pulumi.Input<string>;
    gatewayRef?: {
        name: string;
        namespace: string;
        sectionName: string;
    };
}

export interface HttpRouteSpec {
    componentName: string;
    hostname: pulumi.Input<string>;
    serviceName: pulumi.Input<string>;
    servicePort?: number;
    serviceKind?: string;
    middlewareName?: string;
}

/**
 * Shape of the outputs exported by the core (orangelab) stack, consumed by
 * module stacks via StackReference. Add fields as new cross-stack values are
 * exported.
 */
export interface CoreStackExports {
    config?: {
        customDomain?: string;
        longhorn?: {
            backupAllVolumes?: boolean;
        };
    };
    security?: {
        oidcProviderBaseUrl?: string;
        oidcProviderUrl?: string;
    };
}

export const SmtpSecurity = ['none', 'starttls', 'smtps'] as const;
export type SmtpSecurity = (typeof SmtpSecurity)[number];

export interface SmtpSettingsEnabled {
    enabled: true;
    from: string;
    host: string;
    port: number;
    secure: SmtpSecurity;
    username: string;
    password: pulumi.Output<string>;
}

export interface SmtpSettingsDisabled {
    enabled: false;
}

export type SmtpSettings = SmtpSettingsEnabled | SmtpSettingsDisabled;

/**
 * Service settings needed to publicly expose a TCP port owned by an existing
 * Service (e.g. one created by a Helm chart).
 */
export interface PublicTcpServiceConfig {
    type?: 'LoadBalancer';
    loadBalancerClass?: string;
    externalTrafficPolicy?: 'Local' | 'Cluster';
    annotations?: Record<string, pulumi.Input<string>>;
}

/**
 * Represents a routing provider that creates HTTP and TCP endpoints.
 */
export interface RoutingProvider {
    getPublicTcpService: (params: { hostname: string }) => PublicTcpServiceConfig;
    endpoints: Record<string, pulumi.Input<string>>;
    getHttpEndpointInfo: (hostname: string) => HttpEndpointInfo;
    createHttpRoute: (
        spec: HttpRouteSpec,
        opts?: pulumi.CustomResourceOptions,
    ) => void;
    createHttpEndpoints: (params: {
        serviceName: pulumi.Input<string>;
        httpPorts: ServicePort[];
        component?: string;
        hostname: string;
        middlewareName?: string;
    }) => void;
    createTcpEndpoints: (params: {
        serviceName: pulumi.Input<string>;
        tcpPorts: ServicePort[];
        component?: string;
        hostname: string;
        externalTrafficPolicy?: 'Local' | 'Cluster';
    }) => void;
}
