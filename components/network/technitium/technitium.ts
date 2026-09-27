import {
    Application,
    config,
    createPassword,
    OidcAuthConfig,
    OidcProviderSettings,
} from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

function serializeGroupMap(groupMap: Record<string, string[]>): string {
    return Object.entries(groupMap)
        .flatMap(([role, groups]) => groups.map(group => `${group}:${role}`))
        .join(',');
}

export interface TechnitiumArgs {
    oidc?: OidcProviderSettings;
}

export class Technitium extends pulumi.ComponentResource {
    public readonly endpointUrl: pulumi.Input<string>;
    public readonly users: Record<string, pulumi.Output<string>> = {};

    private readonly app: Application;

    constructor(
        private name: string,
        private args: TechnitiumArgs = {},
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:network:Technitium', name, args, opts);

        this.app = new Application(this, name, {
            oidc: args.oidc,
        }).addStorage();
        const httpEndpointInfo = this.app.network.getHttpEndpointInfo();

        const adminPassword =
            config.getSecret(name, 'adminPassword') ??
            createPassword(this, `${name}-admin-password`);
        this.users = { admin: adminPassword };

        const env: Record<string, pulumi.Input<string> | undefined> = {
            DNS_SERVER_DOMAIN: httpEndpointInfo.hostname,
            DNS_SERVER_FORWARDERS: config.require(name, 'DNS_SERVER_FORWARDERS'),
            DNS_SERVER_FORWARDER_PROTOCOL: config.require(
                name,
                'DNS_SERVER_FORWARDER_PROTOCOL',
            ),
        };
        if (this.app.oidc) this.addSsoEnvironment(env, this.app.oidc);

        this.app.addDeployment({
            clusterIP: '10.43.0.53',
            externalTrafficPolicy: 'Local',
            ports: [
                { name: 'http', port: 5380 },
                { name: 'dns-tcp', port: 53, protocol: 'tcp' },
                { name: 'dns-udp', port: 53, protocol: 'udp' },
            ],
            volumeMounts: [{ mountPath: '/etc/dns' }],
            env,
            envSecret: {
                DNS_SERVER_ADMIN_PASSWORD: this.users.admin,
                DNS_SERVER_SSO_CLIENT_SECRET: this.app.oidc?.clientSecret,
            },
            resources: {
                requests: { cpu: '50m', memory: '128Mi' },
                limits: { memory: '512Mi' },
            },
        });

        this.endpointUrl = httpEndpointInfo.url;
    }

    private addSsoEnvironment(
        env: Record<string, pulumi.Input<string> | undefined>,
        auth: OidcAuthConfig,
    ): void {
        if (auth.providerUrl === undefined) {
            throw new Error(
                'Technitium: SSO enabled (technitium:auth) but the OIDC provider is unavailable. Enable the security module (orangelab:security) in this stack, then deploy.',
            );
        }
        if (auth.groupMap === undefined) {
            throw new Error(
                'Technitium: SSO enabled (technitium:auth) but technitium:auth/groupMap is not configured.',
            );
        }

        env.DNS_SERVER_SSO_ALLOW_SIGNUP = 'true';
        env.DNS_SERVER_SSO_ALLOW_SIGNUP_ONLY_FOR_MAPPED_USERS = 'true';
        env.DNS_SERVER_SSO_AUTHORITY = pulumi.output(auth.providerBaseUrl).apply(url => {
            if (!url) {
                throw new Error(
                    'Technitium: the security module is enabled but the OIDC provider base URL is unavailable. Deploy (or refresh) the security module with the Pocket ID auth provider enabled before deploying this stack.',
                );
            }
            return url;
        });
        env.DNS_SERVER_SSO_CLIENT_ID = auth.clientId;
        env.DNS_SERVER_SSO_GROUP_MAP = serializeGroupMap(auth.groupMap);
        env.DNS_SERVER_SSO_METADATA_ADDRESS = pulumi
            .output(auth.providerUrl)
            .apply(url => {
                if (!url) {
                    throw new Error(
                        'Technitium: the security module is enabled but the OIDC provider URL is unavailable. Deploy (or refresh) the security module with the Pocket ID auth provider enabled before deploying this stack.',
                    );
                }
                return url;
            });
        env.DNS_SERVER_SSO_SCOPES = 'openid,profile,email,groups';
        env.DNS_SERVER_SSO_ENABLED = 'true';
    }
}
