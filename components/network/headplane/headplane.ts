import {
    Application,
    config,
    createPassword,
    OidcAuthConfig,
    OidcProviderSettings,
} from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

import { createHeadplaneConfig } from './headplane-config';

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

                return createHeadplaneConfig({
                    baseUrl: url,
                    oidc:
                        this.oidc && issuer && clientId
                            ? { issuer, clientId }
                            : undefined,
                });
            });
    }
}
