import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import assert from 'node:assert';

interface LocalVolumeArgs {
    appName: string;
    volumeName: string;
    localPath?: string;
    hostPath?: string;
    type?: 'Directory' | 'DirectoryOrCreate' | 'FileOrCreate' | 'CharDevice';
    size?: string;
    namespace: pulumi.Input<string>;
    labels: Record<string, string>;
    affinity?: kubernetes.types.input.core.v1.VolumeNodeAffinity;
}

export class LocalVolume extends pulumi.ComponentResource {
    volumeClaimName?: pulumi.Output<string>;
    private volumeDefinition: kubernetes.types.input.core.v1.Volume;

    constructor(
        private name: string,
        private args: LocalVolumeArgs,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super('orangelab:LocalVolume', name, args, opts);

        assert(
            this.args.hostPath ?? this.args.localPath,
            'Either localPath or hostPath must be provided',
        );

        if (this.args.hostPath) {
            this.volumeDefinition = this.createHostPathVolume();
        } else {
            this.volumeDefinition = this.createLocalVolume();
        }
    }

    getVolumeDefinition(): kubernetes.types.input.core.v1.Volume {
        return this.volumeDefinition;
    }

    private createHostPathVolume(): kubernetes.types.input.core.v1.Volume {
        assert(this.args.hostPath, 'hostPath must be defined');
        return {
            name: this.args.volumeName,
            hostPath: { path: this.args.hostPath, type: this.args.type ?? 'Directory' },
        };
    }

    private createLocalVolume(): kubernetes.types.input.core.v1.Volume {
        assert(this.args.size, 'size is required when using localPath');
        const storageClass = this.createStorageClass();
        const pv = this.createPersistentVolume(storageClass);
        const pvc = this.createPersistentVolumeClaim(storageClass, pv);
        this.volumeClaimName = pvc.metadata.name;

        return {
            name: this.args.volumeName,
            persistentVolumeClaim: { claimName: this.volumeClaimName },
        };
    }

    private createPersistentVolume(
        storageClass: kubernetes.storage.v1.StorageClass,
    ): kubernetes.core.v1.PersistentVolume {
        assert(this.args.localPath, 'localPath must be defined');
        return new kubernetes.core.v1.PersistentVolume(
            `${this.name}-pv`,
            {
                metadata: {
                    name: `${this.args.appName}-${this.args.volumeName}`,
                    labels: this.args.labels,
                },
                spec: {
                    capacity: this.args.size ? { storage: this.args.size } : undefined,
                    accessModes: ['ReadWriteOnce'],
                    persistentVolumeReclaimPolicy: 'Retain',
                    storageClassName: storageClass.metadata.name,
                    local: { path: this.args.localPath },
                    nodeAffinity: this.args.affinity,
                },
            },
            { parent: this },
        );
    }

    private createPersistentVolumeClaim(
        storageClass: kubernetes.storage.v1.StorageClass,
        pv: kubernetes.core.v1.PersistentVolume,
    ): kubernetes.core.v1.PersistentVolumeClaim {
        return new kubernetes.core.v1.PersistentVolumeClaim(
            `${this.name}-pvc`,
            {
                metadata: {
                    name: `${this.args.appName}-${this.args.volumeName}`,
                    namespace: this.args.namespace,
                    labels: this.args.labels,
                },
                spec: {
                    accessModes: ['ReadWriteOnce'],
                    storageClassName: storageClass.metadata.name,
                    volumeName: pv.metadata.name,
                    resources: this.args.size
                        ? { requests: { storage: this.args.size } }
                        : undefined,
                },
            },
            { parent: this },
        );
    }

    private createStorageClass(): kubernetes.storage.v1.StorageClass {
        return new kubernetes.storage.v1.StorageClass(
            `${this.name}-sc`,
            {
                metadata: {
                    name: `${this.args.appName}-${this.args.volumeName}`,
                },
                provisioner: 'kubernetes.io/no-provisioner',
                volumeBindingMode: 'WaitForFirstConsumer',
                reclaimPolicy: 'Retain',
            },
            { parent: this },
        );
    }
}
