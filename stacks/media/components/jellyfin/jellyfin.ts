import { Application, VolumeMount } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import { getMediaStorage } from '../media-storage';

export class Jellyfin extends pulumi.ComponentResource {
    public readonly app: Application;
    private readonly mediaFromVolume?: string;
    private readonly mediaHostPath?: string;

    constructor(
        private name: string,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super('orangelab:media:Jellyfin', name, {}, opts);

        const mediaStorage = getMediaStorage(this.name);
        this.mediaFromVolume = mediaStorage.fromVolume;
        this.mediaHostPath = mediaStorage.hostPath;

        this.app = new Application(this, name).addStorage();

        if (mediaStorage.fromVolume) {
            this.app.addStorage({
                name: 'media',
                fromVolume: mediaStorage.fromVolume,
                size: mediaStorage.storageSize,
                accessMode: 'ReadWriteMany',
            });
        }

        if (mediaStorage.hostPath) {
            this.app.addLocalStorage({
                name: 'media-local',
                hostPath: mediaStorage.hostPath,
            });
        }

        this.createDeployment();
    }

    private createDeployment() {
        const httpEndpointInfo = this.app.network.getHttpEndpointInfo();
        const volumeMounts: VolumeMount[] = [{ mountPath: '/data' }];

        if (this.mediaFromVolume) {
            volumeMounts.push({ mountPath: '/media', name: 'media' });
        }

        if (this.mediaHostPath) {
            volumeMounts.push({
                mountPath: '/media-local',
                name: 'media-local',
            });
        }

        return this.app.addDeployment({
            hostname: httpEndpointInfo.host,
            ports: [
                { name: 'http', port: 8096 },
                { name: 'udp', port: 7359, protocol: 'udp' },
                { name: 'dnla', port: 1900, protocol: 'udp' },
            ],
            volumeMounts,
            env: {
                PUID: '1000',
                PGID: '1000',
                JELLYFIN_DATA_DIR: '/data',
                JELLYFIN_CONFIG_DIR: '/data/config',
                JELLYFIN_CACHE_DIR: '/data/cache',
                JELLYFIN_LOG_DIR: '/data/log',
                JELLYFIN_PublishedServerUrl: httpEndpointInfo.url,
            },
            initContainers: this.mediaFromVolume
                ? [this.createInitContainer(volumeMounts)]
                : undefined,
            resources: {
                requests: { cpu: '100m', memory: '512Mi' },
                limits: { cpu: '2', memory: '2Gi' },
            },
        });
    }

    private createInitContainer(volumeMounts: VolumeMount[]) {
        return {
            name: 'init-media-folders',
            command: [
                'sh',
                '-c',
                [
                    `mkdir -pv /media/downloads`,
                    `mkdir -pv /media/movies`,
                    `mkdir -pv /media/shows`,
                    `mkdir -pv /media/music`,
                    `chown -R 1000:1000 /media`,
                ].join(' && '),
            ],
            volumeMounts,
        };
    }
}
