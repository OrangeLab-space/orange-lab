import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

interface GrafanaJson {
    title: string;
}

interface GrafanaDashboardArgs {
    configJson: GrafanaJson;
    title?: string;
}

export class GrafanaDashboard {
    constructor(
        private name: string,
        args: GrafanaDashboardArgs,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        this.createGrafanaDashboard(args.configJson, opts);
    }

    private createGrafanaDashboard(
        configJson: GrafanaJson,
        opts?: pulumi.ResourceOptions,
    ): void {
        new kubernetes.core.v1.ConfigMap(
            `${this.name}-dashboard`,
            {
                metadata: {
                    name: `${this.name}-dashboard`,
                    labels: {
                        grafana_dashboard: '1',
                    },
                    annotations: {
                        'k8s-sidecar-target-folder': 'OrangeLab',
                    },
                },
                data: {
                    [`${this.name}-dashboard.json`]: JSON.stringify(configJson).replace(
                        /\${DS_PROMETHEUS}/g,
                        'Prometheus',
                    ),
                },
            },
            opts,
        );
    }
}
