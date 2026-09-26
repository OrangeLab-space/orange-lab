import { Application, config, createPassword } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import { getMediaStorage } from '../media-storage';

export class Slskd extends pulumi.ComponentResource {
    public readonly app: Application;
    public readonly apiKey: pulumi.Output<string>;
    public readonly soulseekUsername: pulumi.Output<string>;
    public readonly soulseekPassword: pulumi.Output<string>;
    public readonly webPassword: pulumi.Output<string>;

    constructor(
        private name: string,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super('orangelab:media:Slskd', name, {}, opts);

        this.app = new Application(this, name).addStorage();
        this.apiKey =
            config.getSecret(name, 'SLSKD_API_KEY') ??
            createPassword(this, `${name}-api-key`);
        this.soulseekUsername = pulumi.output(
            config.get(name, 'soulseek/username') ??
                createPassword(this, `${name}-soulseek-username`, { length: 12 }),
        );
        this.soulseekPassword =
            config.getSecret(name, 'soulseek/password') ??
            createPassword(this, `${name}-soulseek-password`);
        this.webPassword =
            config.getSecret(this.name, 'web/password') ??
            createPassword(this, `${name}-web-password`);

        const mediaStorage = getMediaStorage(this.name);

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
        return this.app.addDeployment({
            ports: [
                { name: 'http', port: 5030 },
                { name: 'p2p', port: 50300, protocol: 'tcp' },
            ],
            volumeMounts: [{ mountPath: '/app' }, { mountPath: '/media', name: 'media' }],
            env: {
                SLSKD_DOWNLOADS_DIR: config.require(this.name, 'SLSKD_DOWNLOADS_DIR'),
                SLSKD_SHARED_DIR: config.require(this.name, 'SLSKD_SHARED_DIR'),
                SLSKD_REMOTE_CONFIGURATION: 'false',
            },
            envSecret: {
                SLSKD_DEBUG: this.app.debug ? 'True' : undefined,
                SLSKD_API_KEY: this.apiKey,
                SLSKD_USERNAME: 'slskd',
                SLSKD_PASSWORD: this.webPassword,
                SLSKD_SLSK_USERNAME: this.soulseekUsername,
                SLSKD_SLSK_PASSWORD: this.soulseekPassword,
            },
            resources: {
                requests: { memory: '128Mi' },
                limits: { memory: '512Mi' },
            },
            runAsUser: 1000,
            volumeOwnerUserId: 1000,
        });
    }
}
