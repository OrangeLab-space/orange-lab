import { Application, config, OidcProviderSettings } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

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
    public readonly endpointUrl: pulumi.Input<string>;

    private readonly app: Application;

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

        const issuer = pulumi.output(args.oidc?.providerBaseUrl).apply(url => {
            if (!url) {
                throw new Error(
                    'caddy: the WebFinger document must name the OIDC issuer, but no provider URL is available. Enable the security module (pocket) in this stack, then deploy.',
                );
            }
            return url;
        });

        this.app.addConfigVolume({
            files: { Caddyfile: this.createCaddyfile(issuer) },
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

        this.endpointUrl = this.app.network.endpoints[name];
    }

    private createCaddyfile(issuer: pulumi.Output<string>): pulumi.Output<string> {
        const subject = config.require(this.name, 'webfingerSubject');
        const redirect = config.get(this.name, 'rootRedirect');

        return issuer.apply(url => {
            const webfinger = JSON.stringify({
                subject,
                links: [
                    {
                        rel: 'http://openid.net/specs/connect/1.0/issuer',
                        href: url,
                    },
                ],
            });

            // The catch-all redirect is optional - without it the apex only
            // answers WebFinger and robots.txt, and everything else gets Caddy's
            // own 404. `handle` blocks are exclusive and evaluated in order,
            // which is what gives webfinger and robots.txt precedence.
            const redirectHandler = redirect
                ? `\thandle {\n\t\tredir ${redirect} 302\n\t}\n`
                : '';

            // Backtick strings keep the JSON and the robots.txt body literal, so
            // neither needs Caddyfile escaping.
            return `{
	admin off
	auto_https off
}

:8080 {
	log {
		output stdout
	}

	handle /.well-known/webfinger {
		header Content-Type application/jrd+json
		respond \`${webfinger}\` 200
	}

	handle /robots.txt {
		header Content-Type text/plain
		respond \`User-agent: *
Disallow: /
\` 200
	}
${redirectHandler}
}
`;
        });
    }
}
