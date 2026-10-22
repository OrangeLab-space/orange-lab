import {
    Application,
    config,
    OidcAuthConfig,
    OidcProviderSettings,
    requireOutput,
} from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

import { createHeadscaleConfig } from './headscale-config';

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
        nameservers?: string[];
    };

    constructor(
        private name: string,
        args: HeadscaleArgs = {},
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:network:Headscale', name, args, opts);
        config.requireEnabled(name, 'traefik');

        this.app = new Application(this, name, {
            oidc: args.oidc,
            // Traefik sanitizes X-Forwarded-* and X-Real-IP from untrusted
            // peers but forwards True-Client-IP untouched, and Headscale reads
            // that header first. Removing it forces the client address to come
            // from a header the proxy controls.
            routeRequestHeaders: { 'True-Client-IP': '' },
        }).addStorage();
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
        this.dns = {
            overrideLocalDns: config.requireBoolean(this.name, 'overrideLocalDns'),
            nameservers: config.getCommaSeparated(this.name, 'nameservers'),
        };

        this.app.addDeployment({
            ports: this.derp.enabled
                ? [
                      { name: 'http', port: 8080 },
                      // STUN is raw UDP and no reverse proxy carries it, so it
                      // goes straight out through a LoadBalancer port. `public`
                      // publishes it at `<stunPort> + 10000` for the router
                      // forward; see headscale.md.
                      {
                          name: 'stun',
                          port: this.derp.stunPort,
                          protocol: 'udp',
                          public: true,
                      },
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
                requests: { cpu: '250m', memory: '128Mi' },
                limits: { cpu: '1', memory: '512Mi' },
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
     * Headscale's config names the OIDC issuer, which comes from the security
     * module. Resolving the Outputs here keeps the document renderer pure and
     * turns a missing issuer into a failed deploy rather than a broken file.
     */
    private createConfig(serverUrl: pulumi.Input<string>): pulumi.Output<string> {
        const render = (
            url: string,
            oidc?: { issuer: string; clientId: string },
        ): string =>
            createHeadscaleConfig({
                serverUrl: url,
                trustedProxyCidr: config.require('k3s', 'clusterCidr'),
                baseDomain: config.require(this.name, 'baseDomain'),
                logLevel: this.app.debug ? 'debug' : 'info',
                derp: this.derp,
                dns: this.dns,
                oidc,
            });

        if (!this.oidc) {
            return pulumi.output(serverUrl).apply(url => render(url));
        }

        const issuer = requireOutput(
            this.oidc.providerBaseUrl,
            `${this.name}: the OIDC issuer is unavailable. Deploy (or refresh) the security module with Pocket ID enabled before deploying ${this.name}.`,
        );

        return pulumi
            .all([serverUrl, issuer, this.oidc.clientId])
            .apply(([url, issuer, clientId]) => render(url, { issuer, clientId }));
    }
}
