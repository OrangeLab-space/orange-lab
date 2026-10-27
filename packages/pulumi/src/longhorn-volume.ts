import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import assert from 'node:assert';
import { VolumeAccessMode } from './types';

export interface LonghornVolumeRecurringJobArgs {
    /**
     * Whether this recurring job is attached to the volume.
     */
    enabled: pulumi.Input<boolean>;
    /**
     * Attach the app-specific job instead of the global group.
     */
    customSchedule?: boolean;
    /**
     * Name of the app-specific RecurringJob.
     */
    jobName?: string;
}

export interface LonghornVolumeRecurringJobsArgs {
    backup?: LonghornVolumeRecurringJobArgs;
    snapshot?: LonghornVolumeRecurringJobArgs;
}

interface LonghornVolumeArgs {
    name: string;
    namespace: pulumi.Output<string> | string;
    size: string;
    /**
     * Access mode for the volume. Defaults to 'ReadWriteOnce'.
     */
    accessMode?: VolumeAccessMode;
    /**
     * Storage class to use. Defaults to 'longhorn' if not specified.
     */
    storageClass?: string;
    /**
     * Name of currently detached Longhorn volume.
     * Use with volumes restored from backup. New volume won't be created.
     */
    fromVolume?: string;
    /**
     * Snapshot and backup recurring job configuration for this volume.
     */
    recurringJobs?: LonghornVolumeRecurringJobsArgs;
    /**
     * Labels to apply to the PVC
     */
    labels?: Record<string, string>;
    /**
     * Annotations to apply to the PVC
     */
    annotations?: Record<string, string>;
    /**
     * Volume node affinity
     */
    affinity?: kubernetes.types.input.core.v1.VolumeNodeAffinity;
    /**
     * Create a Kubernetes StorageClass for this static volume.
     */
    createStorageClass?: boolean;
}

const staleReplicaTimeout = (48 * 60).toString();

export class LonghornVolume extends pulumi.ComponentResource {
    volumeClaimName: pulumi.Output<string>;
    storageClassName: pulumi.Output<string>;
    isDynamic: boolean;
    size: pulumi.Output<string>;

    constructor(
        private name: string,
        private args: LonghornVolumeArgs,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super('orangelab:LonghornVolume', name, args, opts);
        assert(
            !(args.storageClass && args.fromVolume),
            'Cannot specify fromVolume when using custom storageClass',
        );

        this.isDynamic = !args.fromVolume;
        const pvc = args.fromVolume ? this.attachVolume() : this.createVolume();
        this.volumeClaimName = pvc.metadata.name;
        this.storageClassName = pvc.spec.storageClassName;
        this.size = pulumi.output(args.size);
    }

    private createVolume() {
        assert(!this.args.fromVolume);
        assert(
            this.args.storageClass,
            'storageClass must be specified when creating a volume',
        );
        return this.createPVC({
            name: this.args.name,
            storageClassName: this.args.storageClass,
        });
    }

    private attachVolume() {
        assert(this.args.fromVolume && !this.args.storageClass);
        if (this.args.createStorageClass) {
            this.createStaticStorageClass(this.args.fromVolume);
        }
        const existingVolume = this.createLonghornPV({
            name: this.args.name,
            volumeHandle: this.args.fromVolume,
        });
        return this.createPVC({
            name: this.args.name,
            storageClassName: existingVolume.spec.storageClassName,
            volumeName: existingVolume.metadata.name,
        });
    }

    private createLonghornPV({
        name,
        volumeHandle,
    }: {
        name: string;
        volumeHandle: string;
    }) {
        return new kubernetes.core.v1.PersistentVolume(
            `${this.name}-pv`,
            {
                metadata: {
                    name,
                    namespace: this.args.namespace,
                },
                spec: {
                    nodeAffinity: this.args.affinity,
                    accessModes: [this.args.accessMode ?? 'ReadWriteOnce'],
                    storageClassName: `longhorn-${volumeHandle}`,
                    capacity: { storage: this.args.size },
                    volumeMode: 'Filesystem',
                    persistentVolumeReclaimPolicy: 'Retain',
                    csi: {
                        driver: 'driver.longhorn.io',
                        fsType: 'ext4',
                        volumeAttributes: {
                            numberOfReplicas: '1',
                            staleReplicaTimeout,
                        },
                        volumeHandle,
                    },
                },
            },
            { parent: this },
        );
    }

    private createPVC({
        name,
        volumeName,
        storageClassName,
    }: {
        name: string;
        volumeName?: pulumi.Output<string>;
        storageClassName: pulumi.Output<string> | string;
    }) {
        const jobs = this.args.recurringJobs;
        const labels = pulumi
            .output({
                backup: jobs?.backup?.enabled ?? false,
                snapshot: jobs?.snapshot?.enabled ?? false,
            })
            .apply(({ backup, snapshot }) => {
                const labels = { ...(this.args.labels ?? {}) };

                labels['recurring-job.longhorn.io/source'] = 'enabled';
                if (jobs?.snapshot?.customSchedule) {
                    labels['recurring-job.longhorn.io/trim'] = 'enabled';
                    if (snapshot && jobs.snapshot.jobName) {
                        labels[
                            `recurring-job.longhorn.io/${jobs.snapshot.jobName}`
                        ] = 'enabled';
                    }
                } else {
                    labels['recurring-job-group.longhorn.io/default'] = 'enabled';
                }

                if (backup) {
                    if (jobs?.backup?.customSchedule) {
                        if (jobs.backup.jobName) {
                            labels[
                                `recurring-job.longhorn.io/${jobs.backup.jobName}`
                            ] = 'enabled';
                        }
                    } else {
                        labels['recurring-job-group.longhorn.io/backup'] = 'enabled';
                    }
                }

                return labels;
            });

        return new kubernetes.core.v1.PersistentVolumeClaim(
            `${this.name}-pvc`,
            {
                metadata: {
                    name,
                    namespace: this.args.namespace,
                    labels,
                    annotations: this.args.annotations,
                },
                spec: {
                    accessModes: [this.args.accessMode ?? 'ReadWriteOnce'],
                    storageClassName,
                    volumeName,
                    resources: { requests: { storage: this.args.size } },
                },
            },
            { parent: this },
        );
    }

    private createStaticStorageClass(volumeHandle: string) {
        return new kubernetes.storage.v1.StorageClass(
            `${this.name}-sc`,
            {
                metadata: { name: `longhorn-${volumeHandle}` },
                provisioner: 'driver.longhorn.io',
                parameters: { staleReplicaTimeout: '30' },
                reclaimPolicy: 'Retain',
                volumeBindingMode: 'Immediate',
                allowVolumeExpansion: true,
            },
            { parent: this, deleteBeforeReplace: true },
        );
    }
}
