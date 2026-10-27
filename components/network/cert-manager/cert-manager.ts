import { Application, config } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

export class CertManager extends pulumi.ComponentResource {
    constructor(name: string, args = {}, opts?: pulumi.ResourceOptions) {
        super('orangelab:network:CertManager', name, args, opts);

        const app = new Application(this, name);

        app.addHelmChart(name, {
            chart: 'cert-manager',
            repo: 'https://charts.jetstack.io',
            values: {
                affinity: app.nodes.getAffinity(),
                crds: {
                    enabled: true,
                    keep: true,
                },
                cainjector: {
                    resources: {
                        requests: { cpu: '50m', memory: '128Mi' },
                        limits: { cpu: '500m', memory: '256Mi' },
                    },
                },
                prometheus: config.enableMonitoring()
                    ? {
                          servicemonitor: {
                              enabled: true,
                          },
                      }
                    : undefined,
                resources: {
                    requests: { cpu: '10m', memory: '64Mi' },
                    limits: { cpu: '500m', memory: '128Mi' },
                },
                webhook: {
                    resources: {
                        requests: { cpu: '10m', memory: '64Mi' },
                        limits: { cpu: '500m', memory: '128Mi' },
                    },
                },
            },
        });
    }
}
