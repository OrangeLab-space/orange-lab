import { config, mergeEndpointExports, OidcProviderSettings } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import { Caddy } from './caddy/caddy';
import { CertManager } from './cert-manager/cert-manager';
import { Headscale } from './headscale/headscale';
import { Headplane } from './headplane/headplane';
import { TailscaleOperator } from './tailscale/tailscale';
import { Technitium } from './technitium/technitium';
import { Traefik } from './traefik/traefik';
import { Zot } from './zot/zot';

export interface NetworkModuleArgs {
    oidc?: OidcProviderSettings;
}

export class NetworkModule extends pulumi.ComponentResource {
    technitium?: Technitium;
    zot?: Zot;
    traefik?: Traefik;
    caddy?: Caddy;
    headscale?: Headscale;
    headplane?: Headplane;

    getExports() {
        return {
            endpoints: mergeEndpointExports(
                this.caddy,
                this.headscale,
                this.headplane,
                this.technitium,
                this.traefik,
                this.zot,
            ),
            apps: {
                technitium: this.technitium
                    ? {
                          resolverIp: this.technitium.resolverIp,
                          users: this.technitium.users,
                      }
                    : undefined,
                zot: this.zot ? { users: this.zot.users } : undefined,
            },
        };
    }

    constructor(name: string, args: NetworkModuleArgs = {}, opts?: pulumi.ResourceOptions) {
        super('orangelab:network', name, args, {
            ...opts,
            aliases: [{ type: 'orangelab:system' }],
        });

        const systemAlias = pulumi.interpolate`urn:pulumi:${pulumi.getStack()}::${pulumi.getProject()}::orangelab:system::system`;

        if (config.isEnabled('tailscale')) {
            new TailscaleOperator(
                'tailscale',
                {},
                {
                    parent: this,
                    aliases: [
                        { type: 'orangelab:system:Tailscale', parent: systemAlias },
                    ],
                },
            );
        }

        let certManager: CertManager | undefined;
        if (config.isEnabled('cert-manager')) {
            certManager = new CertManager(
                'cert-manager',
                {},
                {
                    parent: this,
                    aliases: [
                        { type: 'orangelab:system:CertManager', parent: systemAlias },
                    ],
                },
            );
        }

        if (config.isEnabled('traefik')) {
            this.traefik = new Traefik(
                'traefik',
                { oidc: args.oidc },
                {
                    parent: this,
                    dependsOn: certManager,
                    aliases: [{ type: 'orangelab:system:Traefik', parent: systemAlias }],
                },
            );
        }

        if (config.isEnabled('caddy')) {
            this.caddy = new Caddy(
                'caddy',
                { oidc: args.oidc },
                { parent: this, dependsOn: this.traefik },
            );
        }

        if (config.isEnabled('headscale')) {
            this.headscale = new Headscale(
                'headscale',
                { oidc: args.oidc },
                { parent: this, dependsOn: this.traefik },
            );
        }

        if (config.isEnabled('headplane')) {
            this.headplane = new Headplane(
                'headplane',
                { oidc: args.oidc },
                { parent: this, dependsOn: this.headscale },
            );
        }

        if (config.isEnabled('technitium')) {
            this.technitium = new Technitium(
                'technitium',
                { oidc: args.oidc },
                {
                    parent: this,
                    aliases: [
                        { type: 'orangelab:system:Technitium', parent: systemAlias },
                    ],
                },
            );
        }

        if (config.isEnabled('zot')) {
            this.zot = new Zot('zot', { oidc: args.oidc }, { parent: this });
        }
    }
}
