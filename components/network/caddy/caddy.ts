import { Application, config, OidcProviderSettings } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

import { createCaddyfile } from './caddy-config';

export interface CaddyArgs {
    oidc?: OidcProviderSettings;
}

/**
 * Serves the bare custom domain (`example.com`).
 *
 * Reached through the Traefik public gateway, which terminates TLS with the
 * shared wildcard certificate, so Caddy only speaks plain HTTP on a ClusterIP
 * Service. Nothing about it is reachable except through the apex route.
 *
 * What it serves today is deliberately minimal: a WebFinger document proving
 * domain control for OIDC discovery, a robots.txt that keeps the apex out of
 * search indexes, and a redirect that preserves the previous apex behaviour.
 */
export class Caddy extends pulumi.ComponentResource {
    public readonly app: Application;

    constructor(
        private name: string,
        private args: CaddyArgs = {},
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:network:Caddy', name, args, opts);
        config.requireEnabled(name, 'traefik');

        this.app = new Application(this, name, { oidc: args.oidc });
        if (!this.app.network.publiclyExposed) {
            throw new Error(
                `${name}: the apex is only useful when publicly reachable. Set ${name}:network/public=true and forward the public HTTPS port to it.`,
            );
        }

        this.app.addConfigVolume({
            files: { Caddyfile: this.createConfig(args.oidc?.providerBaseUrl) },
        });

        this.app.addDeployment({
            image: 'caddy:2-alpine',
            // The apex server owns the bare custom domain, and answers on the
            // conventional `www` too. `*.example.com` covers both.
            hostname: 'www',
            apexDomain: true,
            ports: [{ name: 'http', port: 8080 }],
            healthCheck: { httpGet: { path: '/' } },
            volumeMounts: [{ name: 'config', mountPath: '/etc/caddy', readOnly: true }],
            resources: {
                requests: { cpu: '5m', memory: '32Mi' },
                limits: { memory: '128Mi' },
            },
        });
    }

    /**
     * The WebFinger document must name the OIDC issuer, which comes from the
     * security module. Resolving it here keeps the document renderer pure and
     * turns a missing issuer into a failed deploy rather than a broken file.
     */
    private createConfig(
        providerBaseUrl: pulumi.Input<string | undefined>,
    ): pulumi.Output<string> {
        return pulumi.output(providerBaseUrl).apply(url => {
            if (!url) {
                throw new Error(
                    'caddy: the WebFinger document must name the OIDC issuer, but no provider URL is available. Enable the security module (pocket) in this stack, then deploy.',
                );
            }
            return createCaddyfile({
                issuer: url,
                subject: config.require(this.name, 'webfingerSubject'),
                redirect: config.get(this.name, 'rootRedirect'),
            });
        });
    }
}
