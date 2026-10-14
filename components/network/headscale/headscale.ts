import {
    Application,
    config,
    OidcAuthConfig,
    OidcProviderSettings,
} from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

export interface HeadscaleArgs {
    oidc?: OidcProviderSettings;
}

/**
 * Self-hosted Tailscale control plane.
 *
 * Replaces the hosted Tailscale coordination server: nodes and clients get their
 * addresses, keys and policy from this instance, and users authenticate through
 * the stack's own OIDC provider instead of Google/Microsoft/GitHub.
 *
 * Reached through the routing provider like any other app, so TLS termination
 * and the public/private split are handled by Traefik rather than here. Headscale
 * speaks plain HTTP on its ClusterIP Service.
 */
export class Headscale extends pulumi.ComponentResource {
    public readonly app: Application;
    private readonly oidc?: OidcAuthConfig;
    private readonly derp: {
        enabled: boolean;
        stunPort: number;
        regionId: number;
        regionCode: string;
        fallback: boolean;
        externalIp: string | undefined;
    };
    private readonly dns: {
        overrideLocalDns: boolean;
        nameserversSection?: string;
    };

    constructor(
        private name: string,
        args: HeadscaleArgs = {},
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:network:Headscale', name, args, opts);
        config.requireEnabled(name, 'traefik');

        this.app = new Application(this, name, { oidc: args.oidc }).addStorage();
        const httpEndpointInfo = this.app.network.getHttpEndpointInfo();

        // Without an identity provider Headscale falls back to its own local
        // users, created with `headscale users create`. See headscale.md.
        this.oidc = this.app.oidc;

        this.app.addConfigVolume({
            files: { 'config.yaml': this.createConfig(httpEndpointInfo.url) },
            // Headscale reads the OIDC secret from a file rather than from the
            // config document, which keeps it out of the ConfigMap.
            secretFiles: this.oidc
                ? { client_secret: this.oidc.clientSecret }
                : undefined,
        });

        const derpEnabled = config.requireBoolean(this.name, 'derp/enabled');

        this.derp = {
            enabled: derpEnabled,
            stunPort: config.requireNumber(this.name, 'derp/stunPort'),
            regionId: config.requireNumber(this.name, 'derp/regionId'),
            regionCode: config.require(this.name, 'derp/regionCode'),
            fallback: config.requireBoolean(this.name, 'derp/fallback'),
            // The relay's public address. Clients probe a DERP region over
            // UDP before selecting it, and given only a hostname they measure
            // the relay and then decline to use it. Required rather than
            // defaulted: an installation-specific address is not a sensible
            // library default, and a missing one fails silently as a relay
            // that is measured but never selected.
            externalIp: derpEnabled
                ? config.require(this.name, 'derp/externalIp')
                : undefined,
        };

        // Headscale keeps the node's own resolver unless overrideLocalDns is
        // set, in which case it forces the nameservers below onto every client.
        // There is no separate fallback list: the nameservers either become the
        // primary resolvers (override on) or the fallback resolvers (off), and
        // the latter is only consulted by a node using an exit node.
        const nameservers = config.getCommaSeparated(this.name, 'nameservers');

        this.dns = {
            overrideLocalDns: config.requireBoolean(this.name, 'overrideLocalDns'),
            nameserversSection: nameservers
                ? `\n  nameservers:\n    global:\n${nameservers
                      .map((ns) => `      - ${ns}`)
                      .join('\n')}\n`
                : undefined,
        };

        this.app.addDeployment({
            ports: this.derp.enabled
                ? [
                      { name: 'http', port: 8080 },
                      // STUN is raw UDP and no reverse proxy carries it, so it
                      // goes straight out through a LoadBalancer port.
                      { name: 'stun', port: this.derp.stunPort, protocol: 'udp' },
                  ]
                : [{ name: 'http', port: 8080 }],
            // The STUN hostPort is opened by the cluster's own load balancer,
            // which only runs on nodes carrying this label. Staying on such a
            // node keeps the relay reachable; without it the pod would come up
            // healthy and silently answer no STUN requests at all.
            nodeSelector: this.derp.enabled
                ? { 'svccontroller.k3s.cattle.io/enablelb': 'true' }
                : undefined,
            // The image entrypoint is the headscale binary itself; `serve` is its
            // subcommand, so it belongs in args rather than in command.
            commandArgs: ['serve'],
            healthCheck: { httpGet: { path: '/health' } },
            volumeMounts: [
                { name: 'config', mountPath: '/etc/headscale' },
                { mountPath: '/var/lib/headscale' },
            ],
            resources: {
                requests: { cpu: '50m', memory: '128Mi' },
                limits: { memory: '512Mi' },
            },
        });

        // Headplane is served at `/admin` on a hostname of its own. Headscale's
        // hostname is where it used to live, and that name resolves to a WAN
        // address, so anyone following an old link lands here — on a host with
        // nothing at that path. Send them to the admin UI's real address.
        //
        // This lives in the Headscale component rather than the Headplane one
        // because the route has to sit in this namespace: the public Gateway
        // only accepts routes from namespaces opted into public routing, and
        // Headplane's is deliberately not.
        //
        // Temporary, not permanent — it disappears with Headplane.
        if (config.isEnabled('headplane')) {
            const headplaneUrl = pulumi
                .all([
                    config.require('orangelab', 'customDomain'),
                    config.get('headplane', 'hostname') ?? 'headplane',
                ])
                .apply(
                    ([domain, label]) => `https://${label}.${domain}/admin`,
                );

            this.app.network.createHttpRedirect({
                path: '/admin',
                to: headplaneUrl,
                permanent: false,
                // Headscale's hostname carries an explicit WAN-IP record, so a
                // private-only route here would never be reached — not even
                // from the mesh. Visitors from outside are sent to a hostname
                // they cannot resolve, which is the intended outcome: the admin
                // UI is not for them.
                public: true,
            });
        }
    }

    /**
     * The embedded relay is mounted at `/derp` on this instance's own listener
     * and advertises its hostname and port, so clients reach it through the
     * routing provider rather than dialling a public address of their own.
     * STUN is the only part that needs a listener of its own, and Headscale
     * refuses to start without one whenever the relay is enabled.
     */
    private createDerpSection(): string {
        if (!this.derp.enabled) {
            return `derp:
  server:
    enabled: false
  urls:
    - https://controlplane.tailscale.com/derpmap/default
  auto_update_enabled: true`;
        }

        // Headscale fetches `urls` while starting and treats a failure as
        // fatal, so this setting decides whether reaching Tailscale is a
        // prerequisite for the control plane coming up at all.
        const urls = this.derp.fallback
            ? `  urls:
    - https://controlplane.tailscale.com/derpmap/default`
            : '  urls: []';

        return `derp:
  server:
    enabled: true
    region_id: ${String(this.derp.regionId)}
    region_code: ${this.derp.regionCode}
    region_name: ${this.derp.regionCode}
    stun_listen_addr: 0.0.0.0:${String(this.derp.stunPort)}
${this.derp.externalIp === undefined ? '' : `    ipv4: ${this.derp.externalIp}\n`}    # On the volume, so a restart does not present a new key and make every
    # client treat the relay as a different one.
    private_key_path: /var/lib/headscale/derp_server_private.key
    automatically_add_embedded_derp_region: true
${urls}`;
    }

    private createConfig(serverUrl: pulumi.Input<string>): pulumi.Output<string> {
        if (!this.oidc) {
            return pulumi.output(serverUrl).apply(url => this.createConfigFile(url));
        }

        return pulumi
            .all([
                serverUrl,
                this.oidc.providerBaseUrl,
                pulumi.output(this.oidc.clientId),
            ])
            .apply(([url, issuer, clientId]) => {
                if (!issuer) {
                    throw new Error(
                        `${this.name}: the OIDC issuer is unavailable. Deploy (or refresh) the security module with Pocket ID enabled before deploying ${this.name}.`,
                    );
                }
                return this.createConfigFile(url, { issuer, clientId });
            });
    }

    private createConfigFile(
        serverUrl: string,
        oidc?: { issuer: string; clientId: string },
    ): string {
        // Headscale embeds the OIDC client secret through a file path, so it is
        // projected next to this document rather than interpolated into it.
        const oidcSection =
            oidc &&
            `
oidc:
  # Fail at startup rather than serving a login button that cannot work.
  only_start_if_oidc_is_available: true
  issuer: ${oidc.issuer}
  client_id: ${oidc.clientId}
  client_secret_path: /etc/headscale/client_secret
  scope: ["openid", "profile", "email"]
  pkce:
    enabled: true
    method: S256
`;

        return `server_url: ${serverUrl}
listen_addr: 0.0.0.0:8080

# Only the routing provider forwards requests here, so only its address range may
# have its X-Forwarded-For believed. Without this every client is logged as the
# proxy's address.
trusted_proxies:
  - ${config.require('k3s', 'clusterCidr')}

noise:
  private_key_path: /var/lib/headscale/noise_private.key

prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential

# The embedded relay is served at /derp on this same listener, so clients reach
# it through the routing provider like everything else — it needs no port of its
# own. Only STUN is separate, and it is absent unless derp/enabled is set.
${this.createDerpSection()}

database:
  type: sqlite
  sqlite:
    path: /var/lib/headscale/db.sqlite
    write_ahead_log: true

log:
  level: ${this.app.debug ? 'debug' : 'info'}

dns:
  magic_dns: true
  base_domain: ${config.require(this.name, 'baseDomain')}
  override_local_dns: ${String(this.dns.overrideLocalDns)}
${this.dns.nameserversSection ?? ''}${oidcSection ?? ''}`;
    }
}
