import { Application, Nodes, config, OidcProviderSettings } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import assert from 'node:assert';

export interface PrometheusArgs {
    oidc?: OidcProviderSettings;
}

export class Prometheus extends pulumi.ComponentResource {
    public readonly alertmanagerEndpointUrl?: pulumi.Input<string>;
    public readonly prometheusEndpointUrl?: pulumi.Input<string>;
    public readonly grafanaEndpointUrl?: pulumi.Input<string>;
    public readonly grafanaPassword: pulumi.Output<string>;

    private readonly nodes: Nodes;
    private readonly app: Application;

    constructor(name: string, args: PrometheusArgs = {}, opts?: pulumi.ResourceOptions) {
        super('orangelab:monitoring:Prometheus', name, args, opts);

        this.nodes = new Nodes({ appName: name });
        this.app = new Application(this, name, {
            oidc: args.oidc,
        })
            .addStorage({
                createStorageClass: true,
                overrideFullname: `prometheus-${name}-db-prometheus-${name}-0`,
            })
            .addStorage({ name: 'grafana' })
            .addStorage({
                createStorageClass: true,
                name: 'alertmanager',
                overrideFullname: `alertmanager-${name}-db-alertmanager-${name}-0`,
            });
        this.grafanaPassword = config.requireSecret(name, 'grafana/password');
        const prometheusHostname = config.require(name, 'hostname');
        const alertManagerHostname = config.require(name, 'alertmanager/hostname');
        const grafanaHostname = config.require(name, 'grafana/hostname');
        if (this.app.storageOnly) return;
        const grafanaHttpEndpoint = this.app.network.getHttpEndpointInfo(grafanaHostname);
        const prometheusHttpEndpoint =
            this.app.network.getHttpEndpointInfo(prometheusHostname);
        const alertManagerHttpEndpoint =
            this.app.network.getHttpEndpointInfo(alertManagerHostname);
        this.app.addHelmChart(
            name,
            {
                chart: 'kube-prometheus-stack',
                repo: 'https://prometheus-community.github.io/helm-charts',
                values: {
                    alertmanager: {
                        enabled: true,
                        alertmanagerSpec: {
                            affinity: this.nodes.getAffinity(),
                            storage: {
                                volumeClaimTemplate:
                                    this.createVolumeClaimTemplate('alertmanager'),
                            },
                        },
                        ingress: {
                            enabled: true,
                            hosts: [alertManagerHttpEndpoint.hostname],
                            ingressClassName: alertManagerHttpEndpoint.className,
                            tls: [{ hosts: [alertManagerHttpEndpoint.hostname] }],
                        },
                        replicas: 1,
                    },
                    cleanPrometheusOperatorObjectNames: true,
                    coreDns: { enabled: true },
                    defaultRules: { rules: { etcd: false } },
                    fullnameOverride: name,
                    grafana: {
                        enabled: true,
                        adminPassword: this.grafanaPassword,
                        affinity: this.nodes.getAffinity(),
                        ...(this.app.oidc
                            ? {
                                  envRenderSecret: {
                                      GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET: this.app.oidc.clientSecret,
                                  },
                              }
                            : {}),
                        ingress: {
                            enabled: true,
                            hosts: [grafanaHttpEndpoint.hostname],
                            ingressClassName: grafanaHttpEndpoint.className,
                            tls: [{ hosts: [grafanaHttpEndpoint.hostname] }],
                        },
                        persistence: {
                            enabled: true,
                            existingClaim: this.app.storage?.getClaimName('grafana'),
                        },
                        'grafana.ini': {
                            server: {
                                root_url: pulumi.interpolate`${grafanaHttpEndpoint.url}/`,
                            },
                            ...(this.app.oidc
                                ? {
                                      auth: {
                                          oauth_allow_insecure_email_lookup: 'true',
                                      },
                                      'auth.generic_oauth': {
                                          allow_sign_up: 'true',
                                           api_url: pulumi.interpolate`${this.app.oidc.providerBaseUrl}/api/oidc/userinfo`,
                                           auth_url: pulumi.interpolate`${this.app.oidc.providerBaseUrl}/authorize`,
                                           client_id: this.app.oidc.clientId,
                                          client_secret:
                                              '$__env{GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET}',
                                          email_attribute_name: 'email:primary',
                                          enabled: 'true',
                                          name: 'Pocket ID',
                                          role_attribute_path: pulumi
                                              .output(this.app.oidc.adminGroup)
                                              .apply(
                                                  adminGroup =>
                                                      `contains(groups[*], '${adminGroup}') && 'Admin' || 'Viewer'`,
                                              ),
                                          scopes: 'openid email profile groups',
                                          skip_org_role_sync: 'false',
                                           token_url: pulumi.interpolate`${this.app.oidc.providerBaseUrl}/api/oidc/token`,
                                          use_pkce: 'true',
                                      },
                                  }
                                : {}),
                        },
                    },
                    'kube-state-metrics': { affinity: this.nodes.getAffinity() },
                    kubeApiServer: { enabled: true },
                    kubeControllerManager: {
                        enabled: true,
                        serviceMonitor: { https: false },
                    },
                    kubeDns: { enabled: false },
                    kubeEtcd: { enabled: false },
                    kubeProxy: { enabled: true, serviceMonitor: { https: false } },
                    kubeScheduler: { serviceMonitor: { https: false } },
                    kubeStateMetrics: { enabled: true },
                    kubelet: {
                        enabled: true,
                        serviceMonitor: { https: true, insecureSkipVerify: true },
                    },
                    nodeExporter: { enabled: true },
                    prometheus: {
                        enabled: true,
                        ingress: {
                            enabled: true,
                            hosts: [prometheusHttpEndpoint.hostname],
                            ingressClassName: prometheusHttpEndpoint.className,
                            tls: [{ hosts: [prometheusHttpEndpoint.hostname] }],
                        },
                        prometheusSpec: {
                            affinity: this.nodes.getAffinity(),
                            hostNetwork: true,
                            dnsPolicy: 'ClusterFirstWithHostNet',
                            podMonitorSelectorNilUsesHelmValues: false,
                            probeSelectorNilUsesHelmValues: false,
                            ruleSelectorNilUsesHelmValues: false,
                            serviceMonitorSelectorNilUsesHelmValues: false,
                            storageSpec: {
                                volumeClaimTemplate: this.createVolumeClaimTemplate(),
                            },
                        },
                    },
                    'prometheus-node-exporter': { affinity: this.nodes.getAffinity() },
                    prometheusOperator: {
                        enabled: true,
                        affinity: this.nodes.getAffinity(),
                        tls: { enabled: false },
                    },
                },
            },
            { dependsOn: this.app.storage },
        );

        this.alertmanagerEndpointUrl = alertManagerHttpEndpoint.url;
        this.grafanaEndpointUrl = grafanaHttpEndpoint.url;
        this.prometheusEndpointUrl = prometheusHttpEndpoint.url;
    }

    // https://github.com/prometheus-operator/prometheus-operator/blob/main/Documentation/platform/storage.md
    private createVolumeClaimTemplate(componentName?: string) {
        const storage = this.app.storage;
        assert(storage, 'Storage not initialized');
        const isDynamic = storage.isDynamic(componentName);
        return {
            spec: {
                storageClassName: storage.getStorageClass(componentName),
                resources: { requests: { storage: storage.getStorageSize(componentName) } },
                ...(!isDynamic
                    ? {
                          selector: {
                              matchLabels: {
                                  'app.kubernetes.io/name': 'prometheus',
                                  'app.kubernetes.io/component': componentName ?? 'default',
                              },
                          },
                      }
                    : {}),
            },
        };
    }
}
