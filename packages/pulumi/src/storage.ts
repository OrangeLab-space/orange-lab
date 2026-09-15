import * as kubernetes from '@pulumi/kubernetes';
import { ConfigMap, Secret } from '@pulumi/kubernetes/core/v1';
import * as pulumi from '@pulumi/pulumi';
import * as crypto from 'crypto';
import assert from 'node:assert';
import { config } from './config';
import { coreStack, resolveInherited } from './core-stack';
import { LocalVolume } from './local-volume';
import { LonghornVolume } from './longhorn-volume';
import { Metadata } from './metadata';
import { Nodes } from './nodes';
import {
    ConfigVolumeSpec,
    DeviceMountSpec,
    EmptyVolumeSpec,
    LocalVolumeSpec,
    PersistentVolumeSpec,
} from './types';

export class Storage extends pulumi.ComponentResource {
    private defaultStorageClass = 'longhorn';
    private deviceMounts = new Map<string, DeviceMountSpec>();
    private localVolumes = new Map<string, LocalVolume>();
    private longhornVolumes = new Map<string, LonghornVolume>();
    private volumes = new Map<string, kubernetes.types.input.core.v1.Volume>();
    public configFilesHash?: pulumi.Output<string>;

    constructor(
        private appName: string,
        private args: {
            metadata: Metadata;
            nodes: Nodes;
        },
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super('orangelab:Storage', `${appName}-storage`, args, opts);
    }

    getVolumes(): kubernetes.types.input.core.v1.Volume[] {
        return Array.from(this.volumes.values());
    }

    getLocalVolumes(): kubernetes.types.input.core.v1.Volume[] {
        return Array.from(this.localVolumes.values()).map(volume =>
            volume.getVolumeDefinition(),
        );
    }

    addLocalVolume(spec: LocalVolumeSpec) {
        const volumeName = this.getVolumeName(spec.name);
        const volume = new LocalVolume(
            `${this.appName}-storage-${volumeName}`,
            {
                appName: this.appName,
                volumeName: spec.name,
                localPath: spec.localPath,
                hostPath: spec.hostPath,
                type: spec.type,
                size: spec.size,
                namespace: this.args.metadata.namespace,
                labels: this.args.metadata.get({ component: volumeName }).labels,
                affinity: this.args.nodes.getLocalVolumeAffinity(),
            },
            { parent: this },
        );
        this.localVolumes.set(volumeName, volume);
        this.volumes.set(volumeName, volume.getVolumeDefinition());
    }

    addEmptyVolume(volume: EmptyVolumeSpec) {
        const volumeName = this.getVolumeName(volume.name);
        this.volumes.set(volumeName, {
            name: volumeName,
            emptyDir: {
                medium: volume.memory ? 'Memory' : undefined,
                sizeLimit: volume.sizeLimit,
            },
        });
    }

    addDeviceMount(volume: DeviceMountSpec) {
        const volumeName = this.getVolumeName(volume.name);
        this.deviceMounts.set(volumeName, volume);
        this.volumes.set(volumeName, {
            name: volumeName,
            hostPath: { path: volume.hostPath, type: volume.type ?? 'CharDevice' },
        });
    }

    addPersistentVolume(volume?: PersistentVolumeSpec) {
        const volumeName = this.getVolumeName(volume?.name);
        const fullVolumeName = this.getFullVolumeName(volume?.name);
        const prefix = volume?.name ? `${volume.name}/` : '';
        const labels = volume?.name
            ? this.args.metadata.get({ component: volume.name }).labels
            : this.args.metadata.get().labels;
        const fromVolume =
            volume?.fromVolume ?? config.get(this.appName, `${prefix}fromVolume`);
        const storage = new LonghornVolume(
            `${fullVolumeName}-storage`,
            {
                accessMode: volume?.accessMode,
                affinity: this.args.nodes.getVolumeAffinity(volume?.name),
                annotations: volume?.annotations,
                createStorageClass: volume?.createStorageClass,
                enableBackup: this.resolveBackupEnabled(volume?.name),
                fromVolume,
                labels: { ...labels, ...volume?.labels },
                name: volume?.overrideFullname ?? fullVolumeName,
                namespace: this.args.metadata.namespace,
                size:
                    volume?.size ?? config.require(this.appName, `${prefix}storageSize`),
                storageClass: fromVolume
                    ? undefined
                    : this.getDefaultStorageClass(volume?.name),
            },
            { parent: this },
        );
        this.longhornVolumes.set(volumeName, storage);
        this.volumes.set(volumeName, {
            name: volumeName,
            persistentVolumeClaim: { claimName: storage.volumeClaimName },
        });
    }

    // <app>:component/storageClass ?? orangelab:component/storageClass ?? longhorn
    // <app>:storageClass ?? orangelab:storageClass ?? longhorn
    public getDefaultStorageClass(component?: string): string {
        const prefix = component ? `${component}/` : '';
        return (
            config.get(this.appName, `${prefix}storageClass`) ??
            config.get('orangelab', `${prefix}storageClass`) ??
            this.defaultStorageClass
        );
    }

    getClaimName(storageName?: string): pulumi.Output<string> {
        const volumeName = this.getVolumeName(storageName);
        const storage = this.longhornVolumes.get(volumeName);
        assert(storage, `Storage ${volumeName} not found`);
        return storage.volumeClaimName;
    }

    getStorageClass(storageName?: string): pulumi.Output<string> {
        const volumeName = this.getVolumeName(storageName);
        const storage = this.longhornVolumes.get(volumeName);
        assert(storage, `Storage ${volumeName} not found`);
        return storage.storageClassName;
    }

    getStorageSize(storageName?: string): pulumi.Output<string> {
        const volumeName = this.getVolumeName(storageName);
        const storage = this.longhornVolumes.get(volumeName);
        assert(storage, `Storage ${volumeName} not found`);
        return storage.size;
    }

    getVolumeNames(): string[] {
        return Array.from(this.volumes.keys());
    }

    hasLocal(): boolean {
        return this.localVolumes.size > 0 || this.hasDeviceMounts();
    }

    hasDeviceMounts(): boolean {
        return this.deviceMounts.size > 0;
    }

    hasVolumes(): boolean {
        return this.volumes.size > 0;
    }

    private getVolumeName(storageName?: string): string {
        return storageName ?? this.appName;
    }

    private resolveBackupEnabled(volumeName?: string): pulumi.Input<boolean> {
        const prefix = volumeName ? `${volumeName}/` : '';
        const localBackupValue =
            config.getBoolean(this.appName, `${prefix}backupVolume`) ??
            config.getBoolean('longhorn', 'backupAllVolumes');
        if (localBackupValue !== undefined) return localBackupValue;

        return resolveInherited({
            settingName: 'longhorn.backupAllVolumes',
            coreValue: coreStack.outputs.config?.apply(
                coreConfig => coreConfig?.longhorn?.backupAllVolumes,
            ),
        });
    }

    private getFullVolumeName(storageName?: string): string {
        return storageName ? `${this.appName}-${storageName}` : this.appName;
    }

    /**
     * Adds a config volume that contains multiple configuration files mounted in the same folder.
     * Supports both regular files (ConfigMap) and secret files (Secret).
     * @param configVolume The config volume definition (name, files, and/or secretFiles)
     */
    addConfigVolume(configVolume: ConfigVolumeSpec) {
        if (this.configFilesHash) throw new Error('Only one ConfigVolumeSpec supported');

        if (!configVolume.files && !configVolume.secretFiles) {
            throw new Error('Either files or secretFiles must be provided');
        }

        this.configFilesHash = this.getConfigHash(configVolume);
        const volumeName = configVolume.name ?? 'config';
        const hasFiles = configVolume.files !== undefined;
        const hasSecretFiles = configVolume.secretFiles !== undefined;
        const fullName = `${this.appName}-${volumeName}`;
        const configMapName = hasSecretFiles ? `${fullName}-config` : fullName;
        const secretName = hasFiles ? `${fullName}-secret` : fullName;

        if (hasFiles) {
            assert(configVolume.files);
            this.createConfigMap(configMapName, configVolume.files);
        }

        if (hasSecretFiles) {
            assert(configVolume.secretFiles);
            this.createConfigSecret(secretName, configVolume.secretFiles);
        }

        if (hasFiles && hasSecretFiles) {
            this.volumes.set(volumeName, {
                name: volumeName,
                projected: {
                    sources: [
                        { configMap: { name: configMapName } },
                        { secret: { name: secretName } },
                    ],
                },
            });
        } else if (hasFiles) {
            this.volumes.set(volumeName, {
                name: volumeName,
                configMap: { name: configMapName },
            });
        } else {
            assert(hasSecretFiles && configVolume.secretFiles);
            this.volumes.set(volumeName, {
                name: volumeName,
                secret: { secretName },
            });
        }
    }

    private createConfigMap(name: string, files: Record<string, pulumi.Input<string>>) {
        new ConfigMap(
            `${name}-cm`,
            {
                metadata: this.createMetadata(name),
                data: files,
            },
            { parent: this },
        );
    }

    private createConfigSecret(name: string, files: Record<string, pulumi.Input<string>>) {
        new Secret(
            `${name}-secret`,
            {
                metadata: this.createMetadata(name),
                stringData: files,
            },
            { parent: this, deleteBeforeReplace: true },
        );
    }

    private createMetadata(name: string) {
        return {
            name,
            namespace: this.args.metadata.namespace,
            labels: this.args.metadata.get().labels,
        };
    }

    /**
     * Adds a checksum/config annotation based on the given config volume's files.
     * This ensures deployments are restarted when config file contents change.
     */
    private getConfigHash(configVolume: ConfigVolumeSpec) {
        // Sort keys for deterministic hash - combine both files and secretFiles
        const allFiles: Record<string, pulumi.Input<string>> = {
            ...(configVolume.files ?? {}),
            ...(configVolume.secretFiles ?? {}),
        };
        const sortedFiles = Object.keys(allFiles)
            .sort()
            .map(k => ({ k, v: allFiles[k] }));
        return pulumi.jsonStringify(sortedFiles).apply(str => {
            const hash = crypto.createHash('sha256').update(str).digest('hex');
            return hash;
        });
    }

    /**
     * Determines if storage was provisioned dynamically or manually (clone, restore).
     *
     * @param storageName volume name or default when not specified
     * @returns True if storage was provisioned dynamically
     */
    isDynamic(storageName?: string): boolean {
        const volumeName = this.getVolumeName(storageName);
        const storage = this.longhornVolumes.get(volumeName);
        assert(storage, `Storage ${volumeName} not found`);
        return storage.isDynamic;
    }
}
