import {
    Application,
    config,
    GrafanaDashboard,
    HttpEndpointInfo,
    OidcProviderSettings,
    S3Provisioner,
} from '@orangelab/pulumi';
import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import dashboardJson from './longhorn-dashboard.json';

export interface LonghornArgs {
    s3Provisioner?: S3Provisioner;
    oidc?: OidcProviderSettings;
}

export class Longhorn extends pulumi.ComponentResource {
    public readonly endpointUrl?: pulumi.Input<string>;

    private readonly app: Application;
    private readonly chart: kubernetes.helm.v3.Release;

    constructor(
        private name: string,
        private args: LonghornArgs,
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:storage:Longhorn', name, args, opts);

        this.app = new Application(this, name, {
            namespace: `${name}-system`,
            oidc: args.oidc ? { ...args.oidc, protectRoutes: true } : undefined,
        });
        const httpEndpointInfo = this.app.network.getHttpEndpointInfo();

        const middlewareName = this.app.network.oidcMiddlewareName;
        const backupEnabled = config.getBoolean(name, 'backupEnabled') ?? false;
        let backupTarget: string | undefined = undefined;
        let backupTargetCredentialSecret: pulumi.Output<string> | undefined = undefined;
        if (backupEnabled && args.s3Provisioner) {
            const bucketName = config.require(name, 'backupBucket');
            backupTarget = `s3://${bucketName}@lab/`;
            const backupSecret = this.createBackupSecret(bucketName, args.s3Provisioner);
            backupTargetCredentialSecret = backupSecret.metadata.name;
        }

        this.chart = this.createHelmRelease({
            httpEndpointInfo,
            middlewareName,
            backupTarget,
            backupTargetCredentialSecret,
        });

        this.createStorageClasses();
        if (config.getBoolean(name, 'snapshotEnabled')) {
            this.createSnapshotJob();
        }
        if (config.getBoolean(name, 'trimEnabled')) {
            this.createTrimJob();
        }
        if (backupEnabled) {
            this.createBackupJob();
        }
        if (config.enableMonitoring()) {
            new GrafanaDashboard(name, { configJson: dashboardJson }, { parent: this });
        }

        this.endpointUrl = httpEndpointInfo.url;
    }

    private createHelmRelease({
        httpEndpointInfo,
        middlewareName,
        backupTarget,
        backupTargetCredentialSecret,
    }: {
        httpEndpointInfo: HttpEndpointInfo;
        middlewareName?: string;
        backupTarget?: string;
        backupTargetCredentialSecret?: pulumi.Output<string>;
    }) {
        return this.app.addHelmChart(this.name, {
            chart: 'longhorn',
            repo: 'https://charts.longhorn.io',
            values: {
                csi: {
                    attacherReplicaCount: 1,
                    provisionerReplicaCount: 1,
                    resizerReplicaCount: 1,
                    snapshotterReplicaCount: 1,
                },
                defaultBackupStore: backupTarget
                    ? { backupTarget, backupTargetCredentialSecret }
                    : { backupTarget: '', backupTargetCredentialSecret: '' },
                defaultSettings: {
                    allowEmptyDiskSelectorVolume: 'true',
                    allowEmptyNodeSelectorVolume: 'true',
                    autoCleanupRecurringJobBackupSnapshot: 'true',
                    autoCleanupSnapshotAfterOnDemandBackupCompleted: 'true',
                    autoCleanupSnapshotWhenDeleteBackup: 'true',
                    autoCleanupSystemGeneratedSnapshot: 'true',
                    backupConcurrentLimit: '2',
                    concurrentReplicaRebuildPerNodeLimit: '4',
                    defaultDataLocality: config.require('longhorn', 'dataLocality'),
                    defaultReplicaCount: config.require('longhorn', 'replicaCount'),
                    deletingConfirmationFlag: 'false',
                    detachManuallyAttachedVolumesWhenCordoned: 'true',
                    fastReplicaRebuildEnabled: 'true',
                    nodeDownPodDeletionPolicy:
                        'delete-both-statefulset-and-deployment-pod',
                    nodeDrainPolicy: 'always-allow',
                    offlineRelicaRebuilding: 'false',
                    orphanResourceAutoDeletion: config.require(
                        'longhorn',
                        'orphanResourceAutoDeletion',
                    ),
                    recurringJobMaxRetention: '20',
                    removeSnapshotsDuringFilesystemTrim: 'true',
                    replicaAutoBalance: config.require('longhorn', 'replicaAutoBalance'),
                    replicaDiskSoftAntiAffinity: 'true',
                    replicaReplenishmentWaitInterval: '900',
                    replicaSoftAntiAffinity: 'true',
                    replicaZoneSoftAntiAffinity: 'true',
                    snapshotMaxCount: '10',
                    storageMinimalAvailablePercentage: '10',
                    storageOverProvisioningPercentage: '100',
                    storageReservedPercentageForDefaultDisk: '30',
                    systemManagedComponentsNodeSelector:
                        'node-role.kubernetes.io/longhorn=true',
                },
                global: {
                    nodeSelector: {
                        'node-role.kubernetes.io/longhorn': 'true',
                    },
                },
                // Unauthenticated chart routing is disabled when OIDC auth
                // protects the UI (the shared route helper adds the route).
                ...(middlewareName
                    ? {}
                    : httpEndpointInfo.gatewayRef
                      ? {
                            httproute: {
                                enabled: true,
                                hostnames: [httpEndpointInfo.hostname],
                                parentRefs: [httpEndpointInfo.gatewayRef],
                            },
                        }
                      : {
                            ingress: {
                                enabled: true,
                                host: httpEndpointInfo.hostname,
                                ingressClassName: httpEndpointInfo.className,
                                tls: httpEndpointInfo.tls,
                            },
                        }),
                longhornUI: {
                    replicas: 1,
                },
                metrics: config.enableMonitoring()
                    ? { serviceMonitor: { enabled: true } }
                    : undefined,
                persistence: {
                    defaultClassReplicaCount: config.requireNumber(
                        'longhorn',
                        'replicaCount',
                    ),
                    defaultDataLocality: config.require('longhorn', 'dataLocality'),
                },
            },
            httpRoute: middlewareName
                ? {
                      componentName: this.name,
                      serviceName: 'longhorn-frontend',
                      servicePort: 80,
                  }
                : undefined,
        });
    }

    private createStorageClasses() {
        new kubernetes.storage.v1.StorageClass(
            `${this.name}-gpu-storage`,
            {
                metadata: {
                    name: `${this.name}-gpu`,
                    namespace: this.app.metadata.namespace,
                },
                allowVolumeExpansion: true,
                provisioner: 'driver.longhorn.io',
                volumeBindingMode: 'WaitForFirstConsumer',
                reclaimPolicy: 'Delete',
                parameters: {
                    numberOfReplicas: '1',
                    dataLocality: 'strict-local',
                    staleReplicaTimeout: (48 * 60).toString(),
                },
            },
            {
                dependsOn: this.chart,
                parent: this,
                replaceOnChanges: ['*'],
                deleteBeforeReplace: true,
            },
        );
        new kubernetes.storage.v1.StorageClass(
            `${this.name}-large-storage`,
            {
                metadata: {
                    name: `${this.name}-large`,
                    namespace: this.app.metadata.namespace,
                },
                allowVolumeExpansion: true,
                provisioner: 'driver.longhorn.io',
                volumeBindingMode: 'WaitForFirstConsumer',
                reclaimPolicy: 'Delete',
                parameters: {
                    numberOfReplicas: '1',
                    dataLocality: config.require(this.name, 'dataLocality'),
                    staleReplicaTimeout: (48 * 60).toString(),
                },
            },
            {
                dependsOn: this.chart,
                parent: this,
                replaceOnChanges: ['*'],
                deleteBeforeReplace: true,
            },
        );
    }

    private createBackupSecret(bucketName: string, s3Provisioner: S3Provisioner) {
        const { s3EndpointUrl, accessKey, secretKey } = s3Provisioner.create({
            username: this.name,
            bucket: bucketName,
        });
        const secretName = `${this.name}-${s3Provisioner.instanceName}-backup`;
        return new kubernetes.core.v1.Secret(
            `${secretName}-secret`,
            {
                metadata: {
                    name: secretName,
                    namespace: this.app.metadata.namespace,
                },
                stringData: {
                    AWS_ACCESS_KEY_ID: accessKey,
                    AWS_SECRET_ACCESS_KEY: secretKey,
                    AWS_ENDPOINTS: s3EndpointUrl,
                    VIRTUAL_HOSTED_STYLE: 'false',
                },
            },
            { parent: this },
        );
    }

    private createSnapshotJob() {
        const cron = config.require(this.name, 'snapshotCron');
        new kubernetes.apiextensions.CustomResource(
            `${this.name}-snapshot-job`,
            {
                apiVersion: 'longhorn.io/v1beta2',
                kind: 'RecurringJob',
                metadata: {
                    name: 'snapshot',
                    namespace: this.app.metadata.namespace,
                },
                spec: {
                    groups: ['default'],
                    task: 'snapshot',
                    cron,
                    name: 'snapshot',
                    retain: 10,
                    concurrency: 2,
                    labels: { cron },
                },
            },
            { dependsOn: this.chart, parent: this },
        );
    }

    private createBackupJob() {
        const cron = config.require(this.name, 'backupCron');
        new kubernetes.apiextensions.CustomResource(
            `${this.name}-backup-job`,
            {
                apiVersion: 'longhorn.io/v1beta2',
                kind: 'RecurringJob',
                metadata: {
                    name: 'backup',
                    namespace: this.app.metadata.namespace,
                },
                spec: {
                    groups: ['backup'],
                    task: 'backup',
                    cron,
                    name: 'backup',
                    retain: 10,
                    concurrency: 2,
                    labels: { cron },
                    parameters: {
                        'full-backup-interval': config.require(
                            this.name,
                            'backupFullInterval',
                        ),
                    },
                },
            },
            { dependsOn: this.chart, parent: this },
        );
    }

    private createTrimJob() {
        const cron = config.require(this.name, 'trimCron');
        new kubernetes.apiextensions.CustomResource(
            `${this.name}-trim-job`,
            {
                apiVersion: 'longhorn.io/v1beta2',
                kind: 'RecurringJob',
                metadata: {
                    name: 'trim',
                    namespace: this.app.metadata.namespace,
                },
                spec: {
                    groups: ['default'],
                    task: 'filesystem-trim',
                    cron,
                    name: 'trim',
                    retain: 0,
                    concurrency: 2,
                    labels: { cron },
                },
            },
            { dependsOn: this.chart, parent: this },
        );
    }
}
