import {
    Application,
    config,
    HttpEndpointInfo,
    OidcProviderSettings,
} from '@orangelab/pulumi';
import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

export class Traefik extends pulumi.ComponentResource {
    private readonly app: Application;
    private chart: kubernetes.helm.v3.Release;
    private readonly customDomain: string;
    public readonly endpointUrl: pulumi.Input<string>;

    constructor(
        private name: string,
        private args: { oidc?: OidcProviderSettings } = {},
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:network:Traefik', name, args, opts);
        this.customDomain = config.require('orangelab', 'customDomain');
        config.requireEnabled(name, 'cert-manager');
        this.app = new Application(this, name, {
            oidc: args.oidc ? { ...args.oidc, protectRoutes: true } : undefined,
        });
        const crds = this.createGatewayAPICRDs();
        this.chart = this.createChart(crds);
        this.createCertificate();
        const httpEndpointInfo = this.app.network.getHttpEndpointInfo();
        this.endpointUrl = httpEndpointInfo.url;
        this.createDashboard(httpEndpointInfo);
    }

    private createGatewayAPICRDs(): kubernetes.yaml.ConfigFile {
        return new kubernetes.yaml.ConfigFile(
            `${this.name}-gateway-api-crds`,
            { file: config.require(this.name, 'gatewayApiCrdUrl') },
            { parent: this },
        );
    }

    private createChart(crds: kubernetes.yaml.ConfigFile): kubernetes.helm.v3.Release {
        return this.app.addHelmChart(
            this.name,
            {
                chart: 'traefik',
                repo: 'https://traefik.github.io/charts',
                values: {
                    affinity: this.app.nodes.getAffinity(),
                    api: { dashboard: true },
                    deployment: { kind: 'DaemonSet' },
                    experimental: {
                        plugins: {
                            'traefik-oidc-auth': {
                                moduleName: 'github.com/sevensolutions/traefik-oidc-auth',
                                version: 'v0.21.0',
                            },
                        },
                    },
                    gateway: {
                        listeners: {
                            web: {
                                namespacePolicy: { from: 'All' },
                            },
                            websecure: {
                                port: 8443,
                                protocol: 'HTTPS',
                                namespacePolicy: { from: 'All' },
                                mode: 'Terminate',
                                certificateRefs: [
                                    {
                                        kind: 'Secret',
                                        group: '',
                                        name: `${this.customDomain}-tls`,
                                    },
                                ],
                            },
                            tls: {
                                port: 3443,
                                protocol: 'TLS',
                                namespacePolicy: { from: 'All' },
                                mode: 'Terminate',
                                certificateRefs: [
                                    {
                                        kind: 'Secret',
                                        group: '',
                                        name: `${this.customDomain}-tls`,
                                    },
                                ],
                            },
                        },
                    },
                    global: {
                        checkNewVersion: false,
                        sendAnonymousUsage: false,
                    },
                    ingressClass: {
                        enabled: true,
                        isDefaultClass: true,
                        name: 'traefik',
                    },
                    ports: {
                        web: {
                            http: {
                                redirections: {
                                    entryPoint: {
                                        permanent: true,
                                        scheme: 'https',
                                        to: 'websecure',
                                    },
                                },
                            },
                        },
                        tls: {
                            port: 3443,
                            expose: {
                                default: true,
                            },
                            exposedPort: 3443,
                        },
                        websecure: {
                            port: 8443,
                            transport: {
                                respondingTimeouts: {
                                    readTimeout: '30s',
                                },
                            },
                        },
                    },
                    priorityClassName: 'system-cluster-critical',
                    providers: {
                        kubernetesGateway: {
                            enabled: true,
                            experimentalChannel: true,
                        },
                    },
                    service: {
                        ipFamilyPolicy: 'PreferDualStack',
                    },
                    tolerations: [
                        {
                            key: 'CriticalAddonsOnly',
                            operator: 'Exists',
                        },
                        {
                            key: 'node-role.kubernetes.io/control-plane',
                            operator: 'Exists',
                            effect: 'NoSchedule',
                        },
                        {
                            key: 'node-role.kubernetes.io/master',
                            operator: 'Exists',
                            effect: 'NoSchedule',
                        },
                    ],
                },
            },
            { deleteBeforeReplace: true, dependsOn: crds },
        );
    }

    private createCertificate() {
        const clusterIssuer = config.get('cert-manager', 'clusterIssuer');
        if (!clusterIssuer) {
            throw new Error(
                'cert-manager: clusterIssuer is required for wildcard certificate',
            );
        }

        new kubernetes.apiextensions.CustomResource(
            `${this.name}-certificate`,
            {
                apiVersion: 'cert-manager.io/v1',
                kind: 'Certificate',
                metadata: {
                    name: `${this.customDomain}-cert`,
                    namespace: this.app.metadata.namespace,
                },
                spec: {
                    secretName: `${this.customDomain}-tls`,
                    dnsNames: [`*.${this.customDomain}`, this.customDomain],
                    issuerRef: { name: clusterIssuer, kind: 'ClusterIssuer' },
                },
            },
            { parent: this, dependsOn: this.chart },
        );
    }

    private createDashboard(httpEndpointInfo: HttpEndpointInfo) {
        this.app.network.createHttpRoute(
            {
                componentName: 'dashboard',
                hostname: httpEndpointInfo.hostname,
                serviceName: 'api@internal',
                serviceKind: 'TraefikService',
                middlewareName: this.app.network.oidcMiddlewareName,
            },
            { parent: this, dependsOn: this.chart },
        );
    }
}
