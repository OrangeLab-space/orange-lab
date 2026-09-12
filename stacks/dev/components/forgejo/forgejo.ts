import {
    Application,
    config,
    DatabaseConfig,
    HttpEndpointInfo,
    OidcAuthConfig,
    SmtpSecurity,
    SmtpSettings,
} from '@orangelab/pulumi';
import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import assert from 'node:assert';

const SSH_PORT = 2222;

const smtpProtocol: Record<SmtpSecurity, string> = {
    none: 'smtp',
    starttls: 'smtp+starttls',
    smtps: 'smtps',
};

export class Forgejo extends pulumi.ComponentResource {
    public readonly app: Application;
    public readonly serviceUrl?: pulumi.Input<string>;
    public readonly sshUrl?: pulumi.Input<string>;

    private readonly adminSecret?: kubernetes.core.v1.Secret;
    private readonly oidcSecret?: kubernetes.core.v1.Secret;
    private readonly smtpSecret?: kubernetes.core.v1.Secret;
    private readonly dbSecret?: kubernetes.core.v1.Secret;

    constructor(
        private appName: string,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super('orangelab:dev:Forgejo', appName, {}, opts);

        const dbType = config.require(appName, 'db/type');
        if (dbType !== 'sqlite' && dbType !== 'postgres') {
            throw new Error(
                `${appName}: unsupported db/type '${dbType}'. Supported: sqlite, postgres.`,
            );
        }

        this.app = new Application(this, appName).addStorage();
        if (dbType === 'postgres') this.app.addPostgres();
        this.app.addRedis();
        if (this.app.storageOnly) return;

        const dbConfig = dbType === 'postgres' ? this.app.databases?.getConfig() : undefined;
        const redisConfig = this.app.databases?.getConfig('redis');
        if (!redisConfig) throw new Error('Redis not found');
        const auth = this.app.auth.getOidc();
        const smtp = this.app.smtp.getSettings();
        const httpEndpointInfo = this.app.network.getHttpEndpointInfo();

        this.adminSecret = this.createAdminSecret();
        this.oidcSecret = this.createOidcSecret(auth);
        this.smtpSecret = this.createSmtpSecret(smtp);
        this.dbSecret = dbConfig ? this.createDbSecret(dbConfig.password) : undefined;

        this.createHelmChart({ httpEndpointInfo, redisConfig, dbConfig, auth, smtp });

        this.serviceUrl = httpEndpointInfo.url;
        this.sshUrl = pulumi.interpolate`ssh://git@${httpEndpointInfo.hostname}:${SSH_PORT}`;
    }

    private createHelmChart(args: {
        httpEndpointInfo: HttpEndpointInfo;
        redisConfig: DatabaseConfig;
        dbConfig: DatabaseConfig | undefined;
        auth: OidcAuthConfig | undefined;
        smtp: SmtpSettings;
    }) {
        assert(this.adminSecret);
        const adminEmail = config.get(this.appName, 'adminEmail');
        const redisUrl = pulumi.interpolate`redis://${args.redisConfig.hostname}:${args.redisConfig.port}`;
        const sshService = this.app.network.getPublicTcpService(
            config.require(this.appName, 'hostname'),
        );
        const configFromEnvs = [
            ...(this.smtpSecret
                ? [
                      {
                          name: 'FORGEJO__MAILER__PASSWD',
                          valueFrom: {
                              secretKeyRef: {
                                  key: 'MAILER_PASSWD',
                                  name: this.smtpSecret.metadata.name,
                              },
                          },
                      },
                  ]
                : []),
            ...(this.dbSecret
                ? [
                      {
                          name: 'FORGEJO__DATABASE__PASSWD',
                          valueFrom: {
                              secretKeyRef: {
                                  key: 'DB_PASSWD',
                                  name: this.dbSecret.metadata.name,
                              },
                          },
                      },
                  ]
                : []),
        ];

        return this.app.addHelmChart(
            this.appName,
            {
                chart: 'forgejo',
                repo: 'oci://code.forgejo.org/forgejo-helm',
                values: {
                    affinity: this.app.nodes.getAffinity(),
                    gitea: {
                        additionalConfigFromEnvs: configFromEnvs,
                        admin: {
                            existingSecret: this.adminSecret.metadata.name,
                            passwordMode: 'keepUpdated',
                            username: config.require(this.appName, 'adminUsername'),
                            ...(adminEmail ? { email: adminEmail } : {}),
                        },
                        config: {
                            cache: {
                                ADAPTER: 'redis',
                                HOST: pulumi.interpolate`${redisUrl}/1`,
                            },
                            ...(args.dbConfig
                                ? {
                                      database: {
                                          DB_TYPE: 'postgres',
                                          HOST: pulumi.interpolate`${args.dbConfig.hostname}:${args.dbConfig.port}`,
                                          NAME: args.dbConfig.database,
                                          USER: args.dbConfig.username,
                                      },
                                  }
                                : {}),
                            mailer: this.getMailerConfig(args.smtp),
                            ...(args.auth
                                ? {
                                      oauth2_client: {
                                          ACCOUNT_LINKING: 'auto',
                                          ENABLE_AUTO_REGISTRATION: true,
                                          OPENID_CONNECT_SCOPES: 'profile email groups',
                                          UPDATE_AVATAR: true,
                                          USERNAME: 'nickname',
                                      },
                                  }
                                : {}),
                            queue: {
                                CONN_STR: pulumi.interpolate`${redisUrl}/0`,
                                TYPE: 'redis',
                            },
                            server: {
                                SSH_DOMAIN: args.httpEndpointInfo.hostname,
                                SSH_PORT,
                            },
                            ...(args.auth
                                ? {
                                      service: {
                                          DISABLE_REGISTRATION: true,
                                          ENABLE_INTERNAL_SIGNIN: false,
                                      },
                                  }
                                : {}),
                            session: {
                                PROVIDER: 'redis',
                                PROVIDER_CONFIG: pulumi.interpolate`${redisUrl}/2`,
                            },
                        },
                        metrics: {
                            enabled: config.enableMonitoring(),
                        },
                        oauth:
                            args.auth && this.oidcSecret
                                ? [
                                      {
                                          adminGroup: 'admin',
                                          autoDiscoverUrl: args.auth.providerUrl,
                                          existingSecret: this.oidcSecret.metadata.name,
                                          groupClaimName: 'groups',
                                          name: args.auth.providerName ?? 'SSO',
                                          provider: 'openidConnect',
                                      },
                                  ]
                                : [],
                    },
                    ingress: {
                        enabled: true,
                        className: args.httpEndpointInfo.className,
                        hosts: [
                            {
                                host: args.httpEndpointInfo.hostname,
                                paths: [{ path: '/', pathType: 'Prefix' }],
                            },
                        ],
                        tls: [
                            {
                                hosts: [args.httpEndpointInfo.hostname],
                                secretName: args.httpEndpointInfo.tlsSecretName,
                            },
                        ],
                    },
                    persistence: {
                        enabled: true,
                        create: false,
                        claimName: this.app.storage?.getClaimName(),
                    },
                    service: {
                        ssh: {
                            ...sshService,
                            port: SSH_PORT,
                        },
                    },
                },
            },
            { parent: this },
        );
    }

    private getMailerConfig(smtp: SmtpSettings) {
        if (!smtp.enabled) return { ENABLED: false };

        return {
            ENABLED: true,
            FROM: smtp.from,
            PROTOCOL: smtpProtocol[smtp.secure],
            SMTP_ADDR: smtp.host,
            SMTP_PORT: smtp.port,
            USER: smtp.username,
        };
    }

    private createAdminSecret(): kubernetes.core.v1.Secret {
        return new kubernetes.core.v1.Secret(
            `${this.appName}-admin`,
            {
                metadata: this.app.metadata.get({ component: 'admin' }),
                stringData: {
                    password: config.requireSecret(this.appName, 'adminPassword'),
                    username: config.require(this.appName, 'adminUsername'),
                },
            },
            { parent: this },
        );
    }

    private createDbSecret(password: pulumi.Input<string>): kubernetes.core.v1.Secret {
        return new kubernetes.core.v1.Secret(
            `${this.appName}-db`,
            {
                metadata: this.app.metadata.get({ component: 'db' }),
                stringData: { DB_PASSWD: password },
            },
            { parent: this },
        );
    }

    private createOidcSecret(
        auth: OidcAuthConfig | undefined,
    ): kubernetes.core.v1.Secret | undefined {
        if (!auth) return undefined;

        return new kubernetes.core.v1.Secret(
            `${this.appName}-oidc`,
            {
                metadata: this.app.metadata.get({ component: 'oidc' }),
                stringData: {
                    key: auth.clientId,
                    secret: auth.clientSecret,
                },
            },
            { parent: this },
        );
    }

    private createSmtpSecret(smtp: SmtpSettings): kubernetes.core.v1.Secret | undefined {
        if (!smtp.enabled) return undefined;

        return new kubernetes.core.v1.Secret(
            `${this.appName}-smtp`,
            {
                metadata: this.app.metadata.get({ component: 'smtp' }),
                stringData: {
                    MAILER_PASSWD: smtp.password,
                },
            },
            { parent: this },
        );
    }
}
