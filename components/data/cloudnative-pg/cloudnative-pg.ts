import { Application, GrafanaDashboard, config } from '@orangelab/pulumi';
import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import grafanaDashboardJson from './grafana-dashboard.json';

export class CloudNativePG extends pulumi.ComponentResource {
    private readonly app: Application;

    constructor(
        private readonly name: string,
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:data:CloudNativePG', name, {}, opts);

        this.app = new Application(this, name, {
            namespace: 'cnpg-system',
        });

        this.createChart();
        if (config.enableMonitoring()) {
            new GrafanaDashboard(
                this.name,
                {
                    configJson: grafanaDashboardJson,
                    title: 'CloudNativePG',
                },
                { parent: this },
            );
        }
    }

    private createChart(): kubernetes.helm.v3.Release {
        return this.app.addHelmChart(this.name, {
            chart: 'cloudnative-pg',
            repo: 'https://cloudnative-pg.github.io/charts/',
            values: {
                crds: { create: true },
                monitoring: {
                    podMonitorEnabled: config.enableMonitoring(),
                    grafanaDashboard: {
                        enabled: config.enableMonitoring(),
                    },
                },
                config: {
                    clusterWide: true,
                },
                resources: {
                    requests: { cpu: '50m', memory: '128Mi' },
                    limits: { cpu: '500m', memory: '256Mi' },
                },
            },
        });
    }
}
