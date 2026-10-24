import {
    Application,
    config,
    createPassword,
    OidcAuthConfig,
    OidcProviderSettings,
    requireOutput,
} from '@orangelab/pulumi';
import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

import { resolveTechnitiumTor } from './technitium-tor';

function serializeGroupMap(groupMap: Record<string, string[]>): string {
    return Object.entries(groupMap)
        .flatMap(([role, groups]) => groups.map(group => `${group}:${role}`))
        .join(',');
}

export interface TechnitiumArgs {
    oidc?: OidcProviderSettings;
}

export class Technitium extends pulumi.ComponentResource {
    public readonly users: Record<string, pulumi.Output<string>> = {};
    /** External IP of the DNS load balancer, for tailnet clients. */
    public readonly resolverIp: pulumi.Output<string | undefined> | undefined;

    /** Resolver pods use for everything outside the cluster. */
    static readonly clusterIP = '10.43.0.53';

    public readonly app: Application;

    constructor(
        private name: string,
        private args: TechnitiumArgs = {},
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:network:Technitium', name, args, opts);

        const tor = resolveTechnitiumTor(name);

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
            DNS_SERVER_FORWARDERS:
                tor?.forwarders ?? config.require(name, 'DNS_SERVER_FORWARDERS'),
            DNS_SERVER_FORWARDER_PROTOCOL:
                tor?.forwarderProtocol ??
                config.require(name, 'DNS_SERVER_FORWARDER_PROTOCOL'),
        };
        if (this.app.oidc) this.addSsoEnvironment(env, this.app.oidc);

        if (tor) {
            this.app.addConfigVolume(tor.configVolume);
            for (const volume of tor.volumes) this.app.addEmptyVolume(volume);
        }

        this.app.addDeployment({
            clusterIP: Technitium.clusterIP,
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
            initContainers: tor?.initContainers,
            resources: {
                requests: { cpu: '50m', memory: '384Mi' },
                limits: { cpu: '1', memory: '768Mi' },
            },
            sidecars: tor?.sidecars,
        });

        this.resolverIp = this.app.network.getTcpLoadBalancerIp();
        this.forwardPodDns(config.getCommaSeparated(name, 'podNameservers'));
    }

    /**
     * Point pod DNS at Technitium through the `coredns-custom` ConfigMap that
     * k3s mounts into CoreDNS.
     *
     * The Corefile imports `*.override` before its own `forward . /etc/resolv.conf`
     * line, and CoreDNS chains multiple `forward` directives rather than rejecting
     * them, so the override's upstream is tried first and the node's own resolver
     * remains as the fallback. The ClusterIP is used rather than the load balancer
     * address because pod DNS must not depend on the tailnet.
     *
     * `policy sequential` matters: the default is `random`, which would split
     * queries across Technitium and the fallback and silently bypass ad-blocking.
     * Blocked names return NXDOMAIN, which is a successful answer and does not
     * trigger failover, so only an unreachable or erroring Technitium falls
     * through to the next upstream.
     */
    private forwardPodDns(nameservers: string[] | undefined) {
        if (!nameservers?.length) return;

        const upstreams = [Technitium.clusterIP, ...nameservers].join(' ');

        new kubernetes.core.v1.ConfigMap(
            `${this.name}-coredns-custom`,
            {
                metadata: { name: 'coredns-custom', namespace: 'kube-system' },
                data: {
                    'technitium.override': `forward . ${upstreams} {\n  policy sequential\n  failover SERVFAIL REFUSED\n}\n`,
                },
            },
            { parent: this },
        );
    }

    private addSsoEnvironment(
        env: Record<string, pulumi.Input<string> | undefined>,
        auth: OidcAuthConfig,
    ): void {
        if (auth.groupMap === undefined) {
            throw new Error(
                'Technitium: SSO enabled (technitium:auth) but technitium:auth/groupMap is not configured.',
            );
        }

        env.DNS_SERVER_SSO_ALLOW_SIGNUP = 'true';
        env.DNS_SERVER_SSO_ALLOW_SIGNUP_ONLY_FOR_MAPPED_USERS = 'true';
        env.DNS_SERVER_SSO_AUTHORITY = requireOutput(
            auth.providerBaseUrl,
            'Technitium: the security module is enabled but the OIDC provider base URL is unavailable. Deploy (or refresh) the security module with the Pocket ID auth provider enabled before deploying this stack.',
        );
        env.DNS_SERVER_SSO_CLIENT_ID = auth.clientId;
        env.DNS_SERVER_SSO_GROUP_MAP = serializeGroupMap(auth.groupMap);
        env.DNS_SERVER_SSO_METADATA_ADDRESS = requireOutput(
            auth.providerUrl,
            'Technitium: the security module is enabled but the OIDC provider URL is unavailable. Deploy (or refresh) the security module with the Pocket ID auth provider enabled before deploying this stack.',
        );
        env.DNS_SERVER_SSO_SCOPES = 'openid,profile,email,groups';
        env.DNS_SERVER_SSO_ENABLED = 'true';
    }
}
