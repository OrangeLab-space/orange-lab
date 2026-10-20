import { Application, config } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

export class Pocket extends pulumi.ComponentResource {
    public readonly app: Application;
    public readonly oidcProviderBaseUrl: pulumi.Input<string>;
    public readonly oidcProviderUrl: pulumi.Input<string>;

    constructor(
        private readonly name: string,
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:security:Pocket', name, {}, opts);

        this.app = new Application(this, name).addStorage();
        const httpEndpointInfo = this.app.network.getHttpEndpointInfo();
        this.oidcProviderBaseUrl = httpEndpointInfo.url;
        this.oidcProviderUrl = pulumi.interpolate`${httpEndpointInfo.url}/.well-known/openid-configuration`;

        this.app.addDeployment({
            ports: [{ name: 'http', port: 1411 }],
            env: {
                APP_URL: httpEndpointInfo.url,
                TRUST_PROXY: 'true',
            },
            envSecret: {
                ENCRYPTION_KEY: config.requireSecret(name, 'encryptionKey'),
            },
            volumeMounts: [{ mountPath: '/app/data' }],
            resources: {
                requests: { cpu: '5m', memory: '128Mi' },
                limits: { cpu: '1', memory: '256Mi' },
            },
        });
    }
}
