import { Application, InitContainerSpec, VolumeMount } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import { getMediaStorage } from '../media-storage';

export class Transmission extends pulumi.ComponentResource {
    public readonly app: Application;

    constructor(
        private name: string,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super('orangelab:media:Transmission', name, {}, opts);

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
            { mountPath: '/downloads', name: 'media', subPath: 'downloads' },
        ];

        const initVolumeContainer: InitContainerSpec = {
            name: 'init-downloads-dir',
            command: [
                'sh',
                '-c',
                'mkdir -p /media/downloads/complete /media/downloads/incomplete && chown -R 1000:1000 /media/downloads',
            ],
            volumeMounts: [{ mountPath: '/media', name: 'media' }],
        };

        this.app.addDeployment({
            ports: [
                { name: 'http', port: 9091 },
                { name: 'p2p-tcp', port: 51413, protocol: 'tcp' },
                { name: 'p2p-udp', port: 51413, protocol: 'udp' },
            ],
            volumeMounts,
            env: {
                PUID: '1000',
                PGID: '1000',
            },
            initContainers: [initVolumeContainer],
            resources: {
                requests: { cpu: '50m', memory: '64Mi' },
                limits: { cpu: '1', memory: '256Mi' },
            },
        });
    }
}
