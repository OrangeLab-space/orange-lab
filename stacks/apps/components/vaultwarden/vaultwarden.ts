import {
    Application,
    config,
    HttpEndpointInfo,
    OidcAuthConfig,
    SmtpSecurity,
    SmtpSettings,
} from '@orangelab/pulumi';
import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { VaultwardenToken } from './vaultwarden-token';

const smtpSecurity: Record<SmtpSecurity, string> = {
    none: 'off',
    starttls: 'starttls',
    smtps: 'force_tls',
};

export class Vaultwarden extends pulumi.ComponentResource {
    public readonly app: Application;
    public readonly adminToken?: pulumi.Output<string>;
    public readonly serviceUrl?: pulumi.Input<string>;

    constructor(
        private appName: string,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super('orangelab:apps:Vaultwarden', appName, {}, opts);

        this.app = new Application(this, appName).addStorage();
        if (this.app.storageOnly) return;

        const { plainToken, secretResource } = new VaultwardenToken(
            appName,
            this.app.metadata,
            { parent: this },
        );
        const httpEndpointInfo = this.app.network.getHttpEndpointInfo();
        this.createHelmChart({ httpEndpointInfo, adminTokenSecret: secretResource });

        this.adminToken = plainToken;
        this.serviceUrl = httpEndpointInfo.url;
    }

    private createHelmChart({
        httpEndpointInfo,
        adminTokenSecret,
    }: {
        httpEndpointInfo: HttpEndpointInfo;
        adminTokenSecret: kubernetes.core.v1.Secret;
    }) {
        const smtp = this.app.smtp.getSettings();
        const signupsAllowed = config.requireBoolean(this.appName, 'signupsAllowed');
        const signupsVerify = config.requireBoolean(this.appName, 'signupsVerify');
        const auth = this.app.auth.getOidc();

        const smtpSecret = this.createSmtpSecret(smtp);
        const ssoSecret = this.createSsoSecret(auth);

        return this.app.addHelmChart(
            this.appName,
            {
                chart: 'vaultwarden',
                repo: 'https://guerzon.github.io/vaultwarden/',
                values: {
                    adminToken: {
                        existingSecret: adminTokenSecret.metadata.name,
                        existingSecretKey: 'ADMIN_TOKEN_HASH',
                    },
                    affinity: this.app.nodes.getAffinity(),
                    domain: httpEndpointInfo.url,
                    ingress: {
                        enabled: true,
                        class: httpEndpointInfo.className,
                        hostname: httpEndpointInfo.hostname,
                        tls: httpEndpointInfo.tls,
                        tlsSecret: httpEndpointInfo.tlsSecretName,
                    },
                    invitationsAllowed: true,
                    resourceType: 'Deployment',
                    signupsAllowed,
                    signupsVerify,
                    smtp:
                        smtp.enabled && smtpSecret
                            ? {
                                  existingSecret: smtpSecret.metadata.name,
                                  from: smtp.from,
                                  host: smtp.host,
                                  port: smtp.port,
                                  security: smtpSecurity[smtp.secure],
                                  username: { existingSecretKey: 'SMTP_USERNAME' },
                                  password: { existingSecretKey: 'SMTP_PASSWORD' },
                              }
                            : {},
                    sso: this.getSsoConfig(auth, ssoSecret),
                    storage: {
                        enabled: true,
                        existingVolumeClaim: {
                            claimName: this.app.storage?.getClaimName(),
                            dataPath: '/data',
                            attachmentsPath: '/data/attachments',
                        },
                    },
                    strategy: {
                        type: 'Recreate',
                    },
                    webVaultEnabled: true,
                },
            },
            { parent: this },
        );
    }

    private getSsoConfig(
        auth: OidcAuthConfig | undefined,
        secret: kubernetes.core.v1.Secret | undefined,
    ) {
        if (!auth || !secret) return { enabled: false };

        return {
            authority: pulumi.output(auth.providerBaseUrl).apply(url => {
                if (!url) {
                    throw new Error(
                        'Vaultwarden: OIDC enabled (vaultwarden:auth) but the OIDC provider base URL is unavailable. Set orangelab:coreStackRef to a deployed core stack with the auth provider enabled.',
                    );
                }
                return url;
            }),
            clientId: { existingSecretKey: 'SSO_CLIENT_ID' },
            clientSecret: { existingSecretKey: 'SSO_CLIENT_SECRET' },
            enabled: true,
            existingSecret: secret.metadata.name,
            onlySSO: false,
            pkce: true,
            scopes: 'email profile groups offline_access',
            signupsMatchEmail: true,
        };
    }

    private createSsoSecret(
        auth: OidcAuthConfig | undefined,
    ): kubernetes.core.v1.Secret | undefined {
        if (!auth) return undefined;

        return new kubernetes.core.v1.Secret(
            `${this.appName}-sso`,
            {
                metadata: this.app.metadata.get({ component: 'sso' }),
                stringData: {
                    SSO_CLIENT_ID: auth.clientId,
                    SSO_CLIENT_SECRET: auth.clientSecret,
                },
            },
            { parent: this },
        );
    }

    private createSmtpSecret(
        smtp: SmtpSettings,
    ): kubernetes.core.v1.Secret | undefined {
        if (!smtp.enabled) return undefined;

        return new kubernetes.core.v1.Secret(
            `${this.appName}-smtp`,
            {
                metadata: this.app.metadata.get({ component: 'smtp' }),
                stringData: {
                    SMTP_USERNAME: smtp.username,
                    SMTP_PASSWORD: smtp.password,
                },
            },
            { parent: this },
        );
    }
}
