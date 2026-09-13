import { config, OidcProviderSettings } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import { CertManager } from './cert-manager/cert-manager';
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

    getExports() {
        return {
            endpoints: {
                technitium: this.technitium?.endpointUrl,
                zot: this.zot?.endpointUrl,
                traefik: this.traefik?.endpointUrl,
            },
            technitiumUsers: this.technitium?.users,
            zotUsers: this.zot?.users,
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
