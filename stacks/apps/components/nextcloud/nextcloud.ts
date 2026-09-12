import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    Application,
    config,
    DatabaseConfig,
    HttpEndpointInfo,
    OidcAuthConfig,
    SmtpSettings,
} from '@orangelab/pulumi';
import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

export class Nextcloud extends pulumi.ComponentResource {
    public readonly serviceUrl?: pulumi.Input<string>;
    public readonly app: Application;
    public readonly users: Record<string, pulumi.Output<string>> = {};
    public readonly dbConfig?: DatabaseConfig;

    constructor(
        private appName: string,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super('orangelab:Nextcloud', appName, {}, opts);

        this.app = new Application(this, appName).addStorage().addMariaDB().addRedis();
        if (this.app.storageOnly) return;

        this.dbConfig = this.app.databases?.getConfig();
        if (!this.dbConfig) throw new Error('Database not found');
        const redisConfig = this.app.databases?.getConfig('redis');
        if (!redisConfig) throw new Error('Redis not found');
        const adminPassword = config.requireSecret(appName, 'adminPassword');
        const smtp = this.app.smtp.getSettings();
        const appSecret = this.createSecret(adminPassword, smtp);
        const httpEndpointInfo = this.app.network.getHttpEndpointInfo();
        const auth = this.app.auth.getOidc();
        this.users = { admin: adminPassword };
        this.createHelmChart({
            httpEndpointInfo,
            appSecret,
            dbConfig: this.dbConfig,
            redisConfig,
            auth,
            smtp,
        });
        this.serviceUrl = httpEndpointInfo.url;
    }

    private createHelmChart(args: {
        httpEndpointInfo: HttpEndpointInfo;
        appSecret: k8s.core.v1.Secret;
        dbConfig: DatabaseConfig;
        redisConfig: DatabaseConfig;
        auth: OidcAuthConfig | undefined;
        smtp: SmtpSettings;
    }) {
        const waitForDb = this.app.databases?.getWaitContainer();
        const waitForRedis = this.app.databases?.getWaitContainer(args.redisConfig);
        const oidcSecret = this.createOidcSecret(args.auth);
        return this.app.addHelmChart(
            this.appName,
            {
                chart: 'nextcloud',
                repo: 'https://nextcloud.github.io/helm/',
                values: {
                    affinity: this.app.nodes.getAffinity(),
                    cronjob: {
                        enabled: true,
                    },
                    externalDatabase: {
                        enabled: true,
                        type: 'mysql',
                        host: args.dbConfig.hostname,
                        user: args.dbConfig.username,
                        password: args.dbConfig.password,
                        database: args.dbConfig.database,
                    },
                    externalRedis: {
                        enabled: true,
                        host: args.redisConfig.hostname,
                        port: args.redisConfig.port,
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
                    internalDatabase: { enabled: false },
                    livenessProbe: { enabled: true },
                    metrics: { enabled: true },
                    nextcloud: {
                        configs: this.getConfigFiles(args.auth),
                        extraEnv: this.getExtraEnv(args, oidcSecret),
                        extraInitContainers: [waitForDb, waitForRedis],
                        host: args.httpEndpointInfo.hostname,
                        ...(args.auth ? { hooks: { 'before-starting': this.getOidcHook() } } : {}),
                        existingSecret: {
                            enabled: true,
                            secretName: args.appSecret.metadata.name,
                            usernameKey: 'username',
                            passwordKey: 'password',
                        },
                        mail: this.getMailConfig(args.smtp),
                        trustedDomains: [args.httpEndpointInfo.hostname],
                    },
                    persistence: {
                        enabled: true,
                        existingClaim: this.app.storage?.getClaimName(),
                    },
                    phpClientHttpsFix: {
                        enabled: args.httpEndpointInfo.tls,
                        protocol: args.httpEndpointInfo.tls ? 'https' : 'http',
                    },
                    readinessProbe: { enabled: true },
                    replicaCount: 1,
                    startupProbe: { enabled: true },
                },
            },
            { parent: this },
        );
    }

    private getOidcHook(): string {
        return readFileSync(join(__dirname, 'nextcloud-oidc.sh'), 'utf8');
    }

    private getConfigFiles(auth?: OidcAuthConfig) {
        return {
            'disable-skeleton.config.php': `<?php
$CONFIG = array (
    'skeletondirectory' => '',
);`,
            ...(auth
                ? {
                      'allow-local-remote-servers.config.php': `<?php
$CONFIG = array (
    'allow_local_remote_servers' => true,
);`,
                  }
                : {}),
            ...(this.app.debug
                ? {
                      'logging.config.php': `<?php
$CONFIG = array (
    'log_type' => 'errorlog',
);`,
                  }
                : {}),
        };
    }

    private getMailConfig(smtp: SmtpSettings) {
        if (!smtp.enabled) return { enabled: false };

        const [fromAddress, domain] = smtp.from.split('@');
        return {
            enabled: true,
            fromAddress,
            domain,
            smtp: {
                authtype: 'LOGIN',
                port: smtp.port,
                ...(smtp.secure === 'none'
                    ? {}
                    : { secure: smtp.secure === 'starttls' ? 'tls' : 'ssl' }),
            },
        };
    }

    private getExtraEnv(
        args: { httpEndpointInfo: HttpEndpointInfo },
        oidcSecret?: k8s.core.v1.Secret,
    ) {
        const trustedProxies = config
            .require('nextcloud', 'trustedProxies')
            .split(',')
            .map(s => s.trim());
        const groupProvisioningWhitelist = config.require(
            'nextcloud',
            'groupProvisioningWhitelist',
        );
        return [
            { name: 'TRUSTED_PROXIES', value: trustedProxies.join(' ') },
            { name: 'OVERWRITEHOST', value: args.httpEndpointInfo.hostname },
            { name: 'OVERWRITEPROTOCOL', value: 'https' },
            { name: 'OVERWRITECLIURL', value: args.httpEndpointInfo.url },
            ...(oidcSecret
                ? [
                      {
                          name: 'NEXTCLOUD_OIDC_CLIENT_ID',
                          valueFrom: {
                              secretKeyRef: {
                                  name: oidcSecret.metadata.name,
                                  key: 'OIDC_CLIENT_ID',
                              },
                          },
                      },
                      {
                          name: 'NEXTCLOUD_OIDC_CLIENT_SECRET',
                          valueFrom: {
                              secretKeyRef: {
                                  name: oidcSecret.metadata.name,
                                  key: 'OIDC_CLIENT_SECRET',
                              },
                          },
                      },
                      {
                          name: 'NEXTCLOUD_OIDC_DISCOVERY_URI',
                          valueFrom: {
                              secretKeyRef: {
                                  name: oidcSecret.metadata.name,
                                  key: 'OIDC_DISCOVERY_URI',
                              },
                          },
                      },
                      {
                          name: 'NEXTCLOUD_OIDC_GROUP_WHITELIST_REGEX',
                          value: groupProvisioningWhitelist,
                      },
                  ]
                : []),
        ];
    }

    private createOidcSecret(auth: OidcAuthConfig | undefined): k8s.core.v1.Secret | undefined {
        if (!auth) return undefined;

        const discoveryUri = pulumi.output(auth.providerUrl).apply(url => {
            if (!url) {
                throw new Error(
                    'Nextcloud: OIDC enabled (nextcloud:auth) but the OIDC provider URL is unavailable. Set orangelab:coreStackRef to a deployed core stack with the auth provider enabled, or set nextcloud:auth/providerUrl.',
                );
            }
            return url;
        });

        return new k8s.core.v1.Secret(
            `${this.appName}-oidc`,
            {
                metadata: { namespace: this.app.metadata.namespace },
                stringData: {
                    OIDC_CLIENT_ID: auth.clientId,
                    OIDC_CLIENT_SECRET: auth.clientSecret,
                    OIDC_DISCOVERY_URI: discoveryUri,
                },
            },
            { parent: this },
        );
    }

    private createSecret(password: pulumi.Input<string>, smtp: SmtpSettings) {
        return new k8s.core.v1.Secret(
            `${this.appName}-secret`,
            {
                metadata: { namespace: this.app.metadata.namespace },
                stringData: {
                    username: 'admin',
                    password,
                    ...(smtp.enabled
                        ? {
                              'smtp-host': smtp.host,
                              'smtp-username': smtp.username,
                              'smtp-password': smtp.password,
                          }
                        : {}),
                },
            },
            { parent: this },
        );
    }

}
