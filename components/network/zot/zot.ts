import {
    Application,
    config,
    createPassword,
    OidcProviderSettings,
    requireOutput,
} from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import bcrypt from 'bcryptjs';

interface SyncRegistry {
    /** Upstream registry host, also used as the K3s mirror key. */
    host: string;
    /** Upstream base URL Zot syncs from. */
    url: string;
    /** Local path under the registry that clients pull from. */
    destination: string;
}

export interface ZotArgs {
    oidc?: OidcProviderSettings;
}

export class Zot extends pulumi.ComponentResource {
    public readonly users: Record<string, pulumi.Output<string>>;
    public readonly app: Application;

    constructor(
        private name: string,
        private args: ZotArgs = {},
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:network:Zot', name, args, opts);

        this.app = new Application(this, name, { oidc: args.oidc }).addStorage();
        const hostname = config.require(name, 'hostname');
        const externalUrl = this.app.network.getHttpEndpointInfo(hostname).url;

        const adminPassword =
            config.getSecret(name, 'adminPassword') ??
            createPassword(this, `${name}-admin-password`);
        this.users = { admin: adminPassword };

        this.app.addConfigVolume({
            files: { 'config.json': createConfigJson(this.app, name, externalUrl) },
            secretFiles: createSecretFiles(this.app, name, this, adminPassword),
        });

        this.app.addDeployment({
            ports: [{ name: 'http', port: 5000, hostname }],
            healthCheck: { httpGet: { path: '/v2/' } },
            volumeMounts: [
                { name: 'config', mountPath: '/etc/zot', readOnly: true },
                { mountPath: '/var/lib/registry' },
            ],
            resources: {
                requests: { cpu: '500m', memory: '256Mi' },
                limits: { memory: '2Gi' },
            },
        });
    }
}

function createSecretFiles(
    app: Application,
    name: string,
    scope: pulumi.Resource,
    adminPassword: pulumi.Output<string>,
): Record<string, pulumi.Input<string>> {
    const salt = createPassword(scope, `${name}-htpasswd-salt`, { length: 22 });
    const htpasswd = pulumi
        .all([adminPassword, salt])
        .apply(([password, s]) => `admin:${bcrypt.hashSync(password, `$2a$10$${s}`)}`);

    const secretFiles: Record<string, pulumi.Input<string>> = { htpasswd };
    if (app.oidc) {
        secretFiles['oidc-credentials.json'] = pulumi
            .all([app.oidc.clientId, app.oidc.clientSecret])
            .apply(([clientid, clientsecret]) =>
                JSON.stringify({ clientid, clientsecret }),
            );
    }
    return secretFiles;
}

/**
 * Anonymous read access for pulling, htpasswd authentication for pushing.
 * `preserveDigest` keeps upstream digests/signatures intact and requires `docker2s2`.
 */
function createConfigJson(
    app: Application,
    name: string,
    externalUrl: pulumi.Input<string>,
): pulumi.Output<string> {
    const providerName = app.oidc?.providerName ?? '';
    const issuer = app.oidc
        ? requireOutput(
              app.oidc.providerBaseUrl,
              'Zot: SSO enabled (zot:auth) but the OIDC provider base URL is unavailable. Enable the security module in this stack, then deploy.',
          )
        : undefined;

    return pulumi.all([externalUrl, issuer]).apply(([url, issuer]) =>
        JSON.stringify({
            storage: {
                rootDirectory: '/var/lib/registry',
                dedupe: true,
                gc: true,
            },
            http: createHttpConfig(url, issuer, providerName),
            extensions: createExtensions(
                config.require(name, 'scanInterval'),
                config.requireObject(name, 'registries') as SyncRegistry[],
            ),
        }),
    );
}

function createHttpConfig(
    externalUrl: string,
    providerUrl: string | undefined,
    providerName: string,
) {
    return {
        address: '0.0.0.0',
        port: '5000',
        compat: ['docker2s2'],
        externalUrl,
        auth: {
            htpasswd: { path: '/etc/zot/htpasswd' },
            ...(providerUrl ? createOpenidAuth(providerUrl, providerName) : {}),
        },
        accessControl: {
            repositories: {
                '**': {
                    anonymousPolicy: ['read'],
                    defaultPolicy: ['read', 'create', 'update', 'delete'],
                },
            },
        },
    };
}

function createOpenidAuth(providerUrl: string, providerName: string) {
    return {
        openid: {
            providers: {
                oidc: {
                    credentialsFile: '/etc/zot/oidc-credentials.json',
                    issuer: providerUrl,
                    name: providerName || 'SSO',
                    scopes: ['openid', 'profile', 'email', 'groups'],
                    keypath: '',
                },
            },
        },
    };
}

function createExtensions(scanInterval: string, syncRegistries: SyncRegistry[]) {
    return {
        search: {
            enable: true,
            cve: { updateInterval: scanInterval },
        },
        ui: { enable: true },
        sync: {
            enable: true,
            registries: syncRegistries.map(({ url, destination }) => ({
                urls: [url],
                onDemand: true,
                preserveDigest: true,
                content: [{ prefix: '**', destination: `/${destination}` }],
            })),
        },
    };
}
