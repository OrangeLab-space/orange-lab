import { Application, InitContainerSpec, VolumeMount } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import { getMediaStorage } from '../media-storage';

export class Radarr extends pulumi.ComponentResource {
    public readonly app: Application;

    constructor(
        private name: string,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super('orangelab:media:Radarr', name, {}, opts);

        const mediaStorage = getMediaStorage(this.name);

        this.app = new Application(this, name).addStorage();

        if (mediaStorage.fromVolume) {
            this.app.addStorage({
                name: 'media',
                fromVolume: mediaStorage.fromVolume,
                size: mediaStorage.storageSize,
                accessMode: 'ReadWriteMany',
            });
        } else {
            this.app.addLocalStorage({
                name: 'media',
                hostPath: mediaStorage.hostPath,
            });
        }

        this.createDeployment();
    }

    private createDeployment() {
        const volumeMounts: VolumeMount[] = [
            { mountPath: '/config' },
            { mountPath: '/media', name: 'media' },
        ];

        const initDownloadsDir: InitContainerSpec = {
            name: 'init-downloads-dir',
            command: [
                'sh',
                '-c',
                'mkdir -p /media/downloads/complete/radarr && chown -R 1000:1000 /media/downloads/complete/radarr',
            ],
            volumeMounts,
        };

        this.app.addDeployment({
            ports: [{ name: 'http', port: 7878 }],
            volumeMounts,
            initContainers: [initDownloadsDir],
            env: {
                PUID: '1000',
                PGID: '1000',
            },
            resources: {
                requests: { cpu: '50m', memory: '256Mi' },
                limits: { cpu: '1', memory: '512Mi' },
            },
        });
    }
}
