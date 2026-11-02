import { Application, config, ServicePort } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import assert from 'node:assert';

export interface AlbyHubArgs {
    /** In-cluster `host:port` of the stack's Electrs server, used as LDK's chain source. */
    electrsUrl: pulumi.Input<string>;
}

export class AlbyHub extends pulumi.ComponentResource {
    public readonly app: Application;

    constructor(
        private readonly name: string,
        private args: AlbyHubArgs,
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:bitcoin:AlbyHub', name, args, opts);

        this.assertTraefikWhenProtected();
        this.app = new Application(this, name, {
            oidc: { protectRoutes: true },
        }).addStorage();
        if (this.app.storageOnly) return;
        this.createDeployment();
    }

    private createDeployment() {
        const ports: ServicePort[] = [{ name: 'http', port: 8080 }];
        if (this.app.network.publiclyExposed) {
            // Only the Lightning P2P port is published; the UI port stays
            // unmarked so `network/public` never exposes the wallet.
            ports.push({
                name: 'lightning',
                port: 9735,
                protocol: 'tcp',
                public: true,
            });
        }

        this.app.addDeployment({
            ports,
            volumeMounts: [{ mountPath: '/data' }],
            env: {
                WORK_DIR: '/data/albyhub',
                PORT: '8080',
                LOG_LEVEL: this.app.debug ? '5' : '4',
                LDK_ELECTRUM_SERVER: pulumi.interpolate`tcp://${this.args.electrsUrl}`,
                LDK_ANNOUNCEMENT_ADDRESSES: config.get(
                    this.name,
                    'LDK_ANNOUNCEMENT_ADDRESSES',
                ),
            },
            resources: {
                requests: { cpu: '100m', memory: '256Mi' },
                limits: { cpu: '1', memory: '2Gi' },
            },
            runAsUser: 1000,
            volumeOwnerUserId: 1000,
        });
    }

    /**
     * Alby Hub has no native OIDC, so `auth` relies on the shared Traefik
     * middleware. Tailscale ignores it, which would silently leave the wallet
     * UI unprotected.
     */
    private assertTraefikWhenProtected() {
        if (!config.get(this.name, 'auth')) return;
        const provider =
            config.get(this.name, 'routingProvider') ??
            config.get('orangelab', 'routingProvider');
        assert(
            provider === 'traefik',
            `${this.name}: route protection requires orangelab:routingProvider traefik.`,
        );
    }
}
