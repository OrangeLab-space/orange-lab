import { config, mergeEndpointExports, OidcProviderSettings } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import { Beszel } from './beszel/beszel';
import { Prometheus } from './prometheus/prometheus';

export interface MonitoringModuleArgs {
    oidc?: OidcProviderSettings;
}

export class MonitoringModule extends pulumi.ComponentResource {
    prometheus: Prometheus | undefined;
    beszel: Beszel | undefined;

    getExports() {
        return {
            endpoints: mergeEndpointExports(this.prometheus, this.beszel),
            apps: {
                prometheus: this.prometheus
                    ? { grafanaPassword: this.prometheus.grafanaPassword }
                    : undefined,
            },
        };
    }

    constructor(name: string, args: MonitoringModuleArgs = {}, opts?: pulumi.ResourceOptions) {
        super('orangelab:monitoring', name, args, opts);

        if (config.isEnabled('prometheus')) {
            this.prometheus = new Prometheus('prometheus', { oidc: args.oidc }, { parent: this });
        }

        if (config.isEnabled('beszel')) {
            this.beszel = new Beszel('beszel', { oidc: args.oidc }, { parent: this });
        }
    }
}
