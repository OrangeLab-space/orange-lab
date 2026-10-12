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
    public readonly endpointUrl: pulumi.Input<string>;

    private readonly app: Application;
    private readonly oidc?: OidcAuthConfig;

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

        this.app.addDeployment({
            ports: [{ name: 'http', port: 8080 }],
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

        this.endpointUrl = httpEndpointInfo.url;

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

# The embedded DERP relay stays off: it needs a UDP port forward that does not
# exist. Clients fall back to the public DERP map when a direct connection fails.
derp:
  server:
    enabled: false
  urls:
    - https://controlplane.tailscale.com/derpmap/default
  auto_update_enabled: true

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
  # Leave each node's resolver alone. Overriding it would point cluster nodes at
  # public resolvers and break internal name resolution.
  override_local_dns: false
${oidcSection ?? ''}`;
    }
}
