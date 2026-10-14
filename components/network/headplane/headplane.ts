import {
    Application,
    config,
    createPassword,
    OidcAuthConfig,
    OidcProviderSettings,
} from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

export interface HeadplaneArgs {
    oidc?: OidcProviderSettings;
}

/**
 * Web UI for the Headscale control plane.
 *
 * Headplane is a separate server that talks to Headscale over its gRPC admin
 * API — it is not a Headscale feature. Two credentials are involved and neither
 * replaces the other: `headplane:apiKey` lets it act on Headscale, while
 * `headplane:auth` decides who may sign in to this UI.
 *
 * Served on a hostname of its own, under the `/admin` prefix — the only prefix
 * Headplane supports, and not configurable.
 */
export class Headplane extends pulumi.ComponentResource {
    public readonly app: Application;
    private readonly oidc?: OidcAuthConfig;

    constructor(
        private name: string,
        args: HeadplaneArgs = {},
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:network:Headplane', name, args, opts);
        config.requireEnabled(name, 'traefik');

        const oidc = config.get(name, 'auth') ? args.oidc : undefined;

        this.app = new Application(this, name, { oidc }).addStorage();
        this.oidc = this.app.oidc;

        // Served on its own hostname, not Headscale's. That matters: Headscale's
        // name carries an explicit WAN-IP record, so anything mounted under it is
        // reached through the public gateway even from inside the mesh. A name of
        // its own resolves through the wildcard to a mesh address, which makes
        // this private by construction rather than by route placement.
        //
        // `hostnames` takes a bare host; the scheme goes back on for the base
        // URL, which Headplane uses to build its links and the OIDC redirect URI.
        const hostname = pulumi
            .all([
                config.require('orangelab', 'customDomain'),
                config.require(this.name, 'hostname'),
            ])
            .apply(([domain, label]) => `${label}.${domain}`);
        const baseUrl = hostname.apply(host => `https://${host}`);

        this.app.addConfigVolume({
            files: { 'config.yaml': this.createConfig(baseUrl) },
            // Every credential is projected from a file rather than interpolated,
            // which keeps them out of the ConfigMap. Headplane's own rule is the
            // same: a `_path` key is preferred over the inline value.
            secretFiles: {
                api_key: this.getApiKey(),
                cookie_secret:
                    config.getSecret(name, 'cookieSecret') ??
                    createPassword(this, `${name}-cookie-secret`),
                ...(this.oidc ? { client_secret: this.oidc.clientSecret } : {}),
            },
        });

        this.app.addDeployment({
            // `private` suppresses the automatic route at `headplane.<domain>`.
            // Headplane is reached through the route below instead.
            ports: [{ name: 'http', port: 3000, private: true }],
            // Headplane serves the health endpoint beneath its own prefix.
            healthCheck: { httpGet: { path: '/admin/healthz' } },
            volumeMounts: [
                { name: 'config', mountPath: '/etc/headplane' },
                { mountPath: '/var/lib/headplane' },
            ],
            resources: {
                requests: { cpu: '50m', memory: '128Mi' },
                limits: { memory: '512Mi' },
            },
        });

        // `/admin` is the only prefix Headplane supports, so the route matches it
        // rather than serving the whole host. The bare hostname is otherwise a
        // dead end, since that prefix is the only thing routed.
        this.app.network.createHttpRoute({
            servicePort: 3000,
            pathPrefix: '/admin',
        });
        this.app.network.createHttpRedirect({
            path: '/',
            to: pulumi.interpolate`${baseUrl}/admin`,
        });

        this.app.network.addEndpoint(this.name, pulumi.interpolate`${baseUrl}/admin`);
    }

    /**
     * The Headscale API key. Headplane needs one for server-side work such as
     * handling the OIDC callback; mint it with `headscale-apikey.sh` and see
     * headplane.md.
     */
    private getApiKey(): pulumi.Output<string> {
        const apiKey = config.getSecret(this.name, 'apiKey');
        if (!apiKey) {
            throw new Error(
                `${this.name}: headplane:apiKey is required. Run ./components/network/headplane/headscale-apikey.sh, which prints the exact pulumi config set command to use.`,
            );
        }
        return apiKey;
    }

    private createConfig(baseUrl: pulumi.Output<string>): pulumi.Output<string> {
        return pulumi
            .all([baseUrl, this.oidc?.providerBaseUrl, this.oidc?.clientId])
            .apply(([url, issuer, clientId]) => {
                if (this.oidc && !issuer) {
                    throw new Error(
                        `${this.name}: headplane:auth is set but the OIDC issuer is unavailable. Deploy (or refresh) the security module with Pocket ID enabled before deploying ${this.name}.`,
                    );
                }

                const oidcSection =
                    this.oidc && clientId && issuer
                        ? `
oidc:
  issuer: ${issuer}
  client_id: ${clientId}
  client_secret_path: /etc/headplane/client_secret
  scope: "openid profile email groups"
  # Roles come from a Pocket ID group custom claim, not from group names.
  # Pocket ID releases custom claims under the profile scope and does not
  # resolve conflicts between groups setting the same claim, so every group
  # that grants access needs its own value here.
  role_claim: headplane_role
  # Anyone in an allowed group without a role claim gets read-only, rather than
  # the default of no access at all.
  default_role: viewer
  # The OIDC client is shared with Headscale, which requires PKCE. Pocket ID
  # enforces that requirement, so without this the token exchange is rejected
  # with "the 'code_challenge' parameter is missing".
  use_pkce: true
`
                        : '';

                return `server:
  host: "0.0.0.0"
  port: 3000
  base_url: "${url}"
  cookie_secret_path: /etc/headplane/cookie_secret
  cookie_secure: true
  cookie_max_age: 86400
  data_path: "/var/lib/headplane"

headscale:
  # In-cluster Service. Headplane's server calls Headscale directly over gRPC, so
  # this never crosses the public hostname and needs no route of its own.
  url: "http://headscale.headscale.svc.cluster.local:8080"
  api_key_path: /etc/headplane/api_key

# Network management and Web SSH both need read/write access to Headscale's
# config file and the Docker socket. Neither applies to a Kubernetes deployment,
# so they stay off rather than being wired up to something unreachable.
integration:
  agent:
    enabled: false
  docker:
    enabled: false
  kubernetes:
    enabled: false
    # Required by Headplane's own validation even with the integration off.
    pod_name: "headscale"
  proc:
    enabled: false
${oidcSection}`;
            });
    }
}
