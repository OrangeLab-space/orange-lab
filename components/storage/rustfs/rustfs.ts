import { Application, config, OidcAuthConfig, OidcProviderSettings } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import { RustfsProvisioner } from './rustfs-provisioner';

export interface RustfsArgs {
    oidc?: OidcProviderSettings;
}

export class Rustfs extends pulumi.ComponentResource {
    public readonly users: Record<string, pulumi.Output<string>> = {};
    public readonly s3Provisioner: RustfsProvisioner;

    app: Application;
    rootUser: string;
    hostname: string;
    hostnameApi: string;

    constructor(
        private name: string,
        private readonly args: RustfsArgs = {},
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:storage:Rustfs', name, {}, opts);

        this.app = new Application(this, name, {
            oidc: args.oidc,
        }).addLocalStorage({
            name: 'data',
            hostPath: config.require(name, 'dataPath'),
        });

        this.hostname = config.require(name, 'hostname');
        this.hostnameApi = config.require(name, 'hostname-api');
        this.rootUser = config.require(name, 'rootUser');
        const rootPassword = config.requireSecret(name, 'rootPassword');
        this.users = {
            [this.rootUser]: rootPassword,
        };

        this.createDeployment();
        this.s3Provisioner = new RustfsProvisioner(
            `${name}-admin`,
            {
                appName: name,
                metadata: this.app.metadata,
                rootUser: this.rootUser,
                rootPassword: this.users[this.rootUser],
                s3EndpointUrl: this.app.network.clusterEndpoints[`${this.name}-console`],
            },
            { parent: this },
        );
    }

    private createDeployment() {
        const consoleUrl = this.app.network.getHttpEndpointInfo(this.hostname).url;
        this.app.addDeployment({
            volumeOwnerUserId: 10001,
            ports: [
                { name: 'console', port: 9001, hostname: this.hostname },
                { name: 'api', port: 9000, hostname: this.hostnameApi },
            ],
            env: {
                ...this.getBaseEnv(),
                ...this.getOidcEnv(this.app.oidc, consoleUrl),
            },
            envSecret: {
                RUSTFS_SECRET_KEY: this.users[this.rootUser],
                ...this.getOidcSecret(this.app.oidc),
            },
            commandArgs: ['/data'],
            volumeMounts: [{ name: 'data', mountPath: '/data' }],
            resources: {
                requests: { cpu: '1500m', memory: '4Gi' },
                limits: { cpu: '4', memory: '12Gi' },
            },
        });
    }

    private getBaseEnv() {
        return {
            RUSTFS_ACCESS_KEY: this.rootUser,
            RUSTFS_CONSOLE_ENABLE: 'true',
        };
    }

    private getOidcEnv(auth: OidcAuthConfig | undefined, consoleUrl: pulumi.Input<string>) {
        if (!auth) return {};
        return {
            RUSTFS_BROWSER_REDIRECT_URL: consoleUrl,
            RUSTFS_IDENTITY_OPENID_CLAIM_NAME: 'rustfs_policies',
            RUSTFS_IDENTITY_OPENID_CLIENT_ID: auth.clientId,
            RUSTFS_IDENTITY_OPENID_CONFIG_URL: this.resolveProviderUrl(auth),
            RUSTFS_IDENTITY_OPENID_DISPLAY_NAME: 'Pocket ID',
            RUSTFS_IDENTITY_OPENID_EMAIL_CLAIM: 'email',
            RUSTFS_IDENTITY_OPENID_ENABLE: 'true',
            RUSTFS_IDENTITY_OPENID_GROUPS_CLAIM: 'rustfs_policies',
            RUSTFS_IDENTITY_OPENID_REDIRECT_URI: pulumi.interpolate`${consoleUrl}/rustfs/admin/v3/oidc/callback/default`,
            RUSTFS_IDENTITY_OPENID_REDIRECT_URI_DYNAMIC: 'off',
            RUSTFS_IDENTITY_OPENID_SCOPES: 'openid,profile,email,groups',
            RUSTFS_IDENTITY_OPENID_USERNAME_CLAIM: 'preferred_username',
            RUSTFS_OUTBOUND_ALLOW_ORIGINS: this.resolveOutboundAllowOrigins(auth),
        };
    }

    private resolveProviderUrl(auth: OidcAuthConfig) {
        if (auth.providerUrl === undefined) {
            throw new Error(
                'RustFS: OIDC enabled (rustfs:auth) but no OIDC provider URL. Enable Pocket ID in the core stack (pocket:enabled) or set rustfs:auth/providerUrl to override it for testing.',
            );
        }
        return pulumi.output(auth.providerUrl).apply(url => {
            if (!url) {
                throw new Error(
                    'RustFS: OIDC enabled (rustfs:auth) but the OIDC provider URL is unavailable. Enable Pocket ID in the core stack (pocket:enabled) or set rustfs:auth/providerUrl to override it for testing.',
                );
            }
            return url;
        });
    }

    private resolveOutboundAllowOrigins(auth: OidcAuthConfig) {
        return this.resolveProviderUrl(auth).apply(url => {
            const parsed = new URL(url);
            return `${parsed.protocol}//${parsed.hostname}`;
        });
    }

    private getOidcSecret(auth: OidcAuthConfig | undefined) {
        if (!auth) return {};
        return { RUSTFS_IDENTITY_OPENID_CLIENT_SECRET: auth.clientSecret };
    }

}
