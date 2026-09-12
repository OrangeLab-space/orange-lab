import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { config } from './config';
import { coreStack, resolveInherited } from './core-stack';
import { Metadata } from './metadata';
import {
    HttpEndpointInfo,
    HttpRouteSpec,
    PublicTcpServiceConfig,
    RoutingProvider,
    ServicePort,
} from './types';

export class TraefikNetwork implements RoutingProvider {
    endpoints: Record<string, pulumi.Input<string>> = {};
    customDomain: pulumi.Input<string>;

    constructor(
        private appName: string,
        private args: { metadata: Metadata },
        private opts?: pulumi.ComponentResourceOptions,
    ) {
        this.customDomain = this.resolveCustomDomain();
    }

    getHttpEndpointInfo(hostname: string): HttpEndpointInfo {
        return {
            className: 'traefik',
            host: hostname,
            hostname: pulumi.interpolate`${hostname}.${this.customDomain}`,
            url: pulumi.interpolate`https://${hostname}.${this.customDomain}`,
            tls: true,
            tlsSecretName: `${hostname}-tls-secret`,
            domain: this.customDomain,
            gatewayRef: {
                name: 'traefik-gateway',
                namespace: 'traefik',
                sectionName: 'websecure',
            },
        };
    }

    getPublicTcpService(): PublicTcpServiceConfig {
        return { type: 'LoadBalancer' };
    }

    createHttpRoute(
        spec: HttpRouteSpec,
        opts?: pulumi.CustomResourceOptions,
    ): void {
        const metadata = this.args.metadata.get({ component: spec.componentName });
        if (spec.serviceKind === 'TraefikService') {
            new kubernetes.apiextensions.CustomResource(
                `${metadata.name}-ingressroute`,
                {
                    apiVersion: 'traefik.io/v1alpha1',
                    kind: 'IngressRoute',
                    metadata,
                    spec: {
                        entryPoints: ['websecure'],
                        routes: [
                            {
                                match: pulumi.interpolate`Host(\`${spec.hostname}\`)`,
                                kind: 'Rule',
                                ...(spec.middlewareName
                                    ? { middlewares: [{ name: spec.middlewareName }] }
                                    : {}),
                                services: [
                                    { name: spec.serviceName, kind: spec.serviceKind },
                                ],
                            },
                        ],
                        tls: { secretName: pulumi.interpolate`${this.customDomain}-tls` },
                    },
                },
                { ...this.opts, ...opts },
            );
            return;
        }
        new kubernetes.apiextensions.CustomResource(
            `${metadata.name}-httproute`,
            {
                apiVersion: 'gateway.networking.k8s.io/v1',
                kind: 'HTTPRoute',
                metadata,
                spec: {
                    parentRefs: [
                        {
                            name: 'traefik-gateway',
                            namespace: 'traefik',
                            sectionName: 'websecure',
                        },
                    ],
                    hostnames: [spec.hostname],
                    rules: [
                        {
                            ...(spec.middlewareName
                                ? {
                                      filters: [
                                          {
                                              type: 'ExtensionRef',
                                              extensionRef: {
                                                  group: 'traefik.io',
                                                  kind: 'Middleware',
                                                  name: spec.middlewareName,
                                              },
                                          },
                                      ],
                                  }
                                : {}),
                            backendRefs: [
                                {
                                    name: spec.serviceName,
                                    ...(spec.servicePort === undefined
                                        ? {}
                                        : { port: spec.servicePort }),
                                    ...(spec.serviceKind === undefined
                                        ? {}
                                        : { kind: spec.serviceKind }),
                                },
                            ],
                        },
                    ],
                },
            },
            { ...this.opts, ...opts },
        );
    }

    createHttpEndpoints(params: {
        serviceName: pulumi.Input<string>;
        httpPorts: ServicePort[];
        component?: string;
        hostname: string;
        middlewareName?: string;
    }): void {
        params.httpPorts.forEach(portSpec => {
            const portHostname = portSpec.hostname ?? params.hostname;
            const httpEndpointInfo = this.getHttpEndpointInfo(portHostname);
            const portComponentName = [params.component, portSpec.name]
                .filter(Boolean)
                .join('-');

            this.createHttpBackendRoute({
                hostname: httpEndpointInfo.hostname,
                componentName: portComponentName,
                serviceName: params.serviceName,
                servicePort: portSpec.port,
                middlewareName: params.middlewareName,
            });
        });
        this.exportHttpEndpoints(params);
    }

    private createHttpBackendRoute(params: {
        hostname: pulumi.Input<string>;
        componentName: string;
        serviceName: pulumi.Input<string>;
        servicePort: number;
        middlewareName?: string;
    }): void {
        const metadata = this.args.metadata.get({ component: params.componentName });
        new kubernetes.apiextensions.CustomResource(
            `${metadata.name}-httproute`,
            {
                apiVersion: 'gateway.networking.k8s.io/v1',
                kind: 'HTTPRoute',
                metadata,
                spec: {
                    parentRefs: [
                        {
                            name: 'traefik-gateway',
                            namespace: 'traefik',
                            sectionName: 'websecure',
                        },
                    ],
                    hostnames: [params.hostname],
                    rules: [
                        {
                            ...(params.middlewareName
                                ? {
                                      filters: [
                                          {
                                              type: 'ExtensionRef',
                                              extensionRef: {
                                                  group: 'traefik.io',
                                                  kind: 'Middleware',
                                                  name: params.middlewareName,
                                              },
                                          },
                                      ],
                                  }
                                : {}),
                            backendRefs: [
                                {
                                    name: params.serviceName,
                                    port: params.servicePort,
                                },
                            ],
                        },
                    ],
                },
            },
            this.opts,
        );
    }

    createTcpEndpoints(params: {
        serviceName: pulumi.Input<string>;
        tcpPorts: ServicePort[];
        component?: string;
        hostname: string;
        externalTrafficPolicy?: 'Local' | 'Cluster';
    }): void {
        if (params.tcpPorts.length === 0) return;
        this.createTlsRoutes({
            component: params.component,
            tlsPorts: params.tcpPorts.filter(p => p.protocol === 'tls'),
            serviceName: params.serviceName,
            hostname: pulumi.interpolate`${params.hostname}.${this.customDomain}`,
        });
        this.createInternalLoadBalancer({
            component: params.component,
            tcpPorts: params.tcpPorts.filter(
                p => p.protocol === 'tcp' || p.protocol === 'udp',
            ),
            externalTrafficPolicy: params.externalTrafficPolicy,
        });

        this.exportTcpEndpoints({
            component: params.component,
            tcpPorts: params.tcpPorts,
            hostname: pulumi.interpolate`${params.hostname}.${this.customDomain}`,
        });
    }

    private createTlsRoutes(params: {
        component?: string;
        tlsPorts: ServicePort[];
        serviceName: pulumi.Input<string>;
        hostname: pulumi.Input<string>;
    }): void {
        const metadata = this.args.metadata.get({ component: params.component });
        params.tlsPorts.forEach(port => {
            new kubernetes.apiextensions.CustomResource(
                `${metadata.name}-${port.name}-tlsroute`,
                {
                    apiVersion: 'gateway.networking.k8s.io/v1alpha2',
                    kind: 'TLSRoute',
                    metadata: this.args.metadata.get({
                        component: params.component
                            ? `${params.component}-${port.name}`
                            : port.name,
                    }),
                    spec: {
                        parentRefs: [
                            {
                                name: 'traefik-gateway',
                                namespace: 'traefik',
                                sectionName: 'tls',
                            },
                        ],
                        hostnames: [params.hostname],
                        rules: [
                            {
                                backendRefs: [
                                    {
                                        name: params.serviceName,
                                        port: port.port,
                                    },
                                ],
                            },
                        ],
                    },
                },
                { parent: this.opts?.parent },
            );
        });
    }

    private createInternalLoadBalancer(params: {
        component?: string;
        tcpPorts: ServicePort[];
        externalTrafficPolicy?: 'Local' | 'Cluster';
    }): void {
        const metadata = this.args.metadata.get({ component: params.component });
        if (params.tcpPorts.length === 0) return;

        new kubernetes.core.v1.Service(
            `${metadata.name}-lb`,
            {
                metadata: {
                    ...metadata,
                    name: `${metadata.name}-lb`,
                },
                spec: {
                    type: 'LoadBalancer',
                    externalTrafficPolicy: params.externalTrafficPolicy,
                    ports: params.tcpPorts.flatMap(p => [
                        {
                            name: p.name,
                            protocol: p.protocol === 'udp' ? 'UDP' : 'TCP',
                            port: p.port,
                            targetPort: p.port,
                        },
                    ]),
                    selector: this.args.metadata.getSelectorLabels(params.component),
                },
            },
            {
                ...this.opts,
                deleteBeforeReplace: true,
            },
        );
    }

    private exportHttpEndpoints(params: {
        component?: string;
        httpPorts: ServicePort[];
        hostname: string;
        serviceName: pulumi.Input<string>;
    }): void {
        params.httpPorts.forEach(port => {
            const portHostname = port.hostname ?? params.hostname;
            const httpEndpointInfo = this.getHttpEndpointInfo(portHostname);
            const key = this.getEndpointKey({
                component: params.component,
                portName: port.name,
            });
            this.endpoints[key] =
                pulumi.interpolate`https://${httpEndpointInfo.hostname}`;
        });
    }

    private exportTcpEndpoints(params: {
        component?: string;
        tcpPorts: ServicePort[];
        hostname: pulumi.Input<string>;
    }): void {
        params.tcpPorts.forEach(port => {
            const key = this.getEndpointKey({
                component: params.component,
                portName: port.name,
            });
            this.endpoints[key] =
                port.protocol === 'tls'
                    ? pulumi.interpolate`${params.hostname}:3443`
                    : pulumi.interpolate`${params.hostname}:${port.port}`;
        });
    }

    private getEndpointKey(params: { component?: string; portName: string }): string {
        return [
            this.appName,
            params.component,
            params.portName === 'http' ? undefined : params.portName,
        ]
            .filter(Boolean)
            .join('-');
    }

    private resolveCustomDomain(): pulumi.Input<string> {
        const localDomain = config.get('orangelab', 'customDomain');
        if (localDomain !== undefined) return localDomain;

        return resolveInherited({
            settingName: 'customDomain',
            coreValue: coreStack.outputs.config?.apply(coreConfig => coreConfig?.customDomain),
        });
    }
}
