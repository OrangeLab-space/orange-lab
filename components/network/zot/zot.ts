import { Application, config, OidcProviderSettings } from '@orangelab/pulumi';
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
    public readonly endpointUrl: pulumi.Input<string>;
    public readonly users: Record<string, pulumi.Output<string>>;

    constructor(
        private name: string,
        private args: ZotArgs = {},
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:network:Zot', name, args, opts);

        const app = new Application(this, name, { oidc: args.oidc }).addStorage();
        const hostname = config.require(name, 'hostname');
        const externalUrl = app.network.getHttpEndpointInfo(hostname).url;

        const adminPassword =
            config.getSecret(name, 'adminPassword') ??
            app.createPassword('admin-password');
        this.users = { admin: adminPassword };

        app.addConfigVolume({
            files: { 'config.json': createConfigJson(app, name, externalUrl) },
            secretFiles: createSecretFiles(app, adminPassword),
        });

        app.addDeployment({
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

        this.endpointUrl = externalUrl;
    }
}

function createSecretFiles(
    app: Application,
    adminPassword: pulumi.Output<string>,
): Record<string, pulumi.Input<string>> {
    const salt = app.createPassword('htpasswd-salt', { length: 22 });
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
    const providerUrl = app.oidc?.providerBaseUrl;
    const providerName = app.oidc?.providerName ?? '';

    return pulumi
        .all([externalUrl, pulumi.output(providerUrl)])
        .apply(([url, issuer]) => {
            if (app.oidc && !issuer) {
                throw new Error(
                    'Zot: SSO enabled (zot:auth) but the OIDC provider base URL is unavailable. Enable the security module in this stack, then deploy.',
                );
            }
            return JSON.stringify({
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
            });
        });
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
