import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { config } from './config';
import { coreStack, resolveInherited } from './core-stack';
import {
    HttpEndpointInfo,
    HttpRedirectSpec,
    HttpRouteSpec,
    PublicTcpServiceConfig,
    RoutingProvider,
    RoutingProviderArgs,
    ServicePort,
} from './types';
import { createRouteMiddleware } from './traefik-middlewares';

/**
 * Public LoadBalancer ports are published at `<port> + publicPortOffset`, so a
 * port keeps its own number for private reach.
 */
const publicPortOffset = 10000;

/** Gateway serving routes within the tailnet. */
const privateGatewayRef = {
    name: 'traefik-gateway',
    namespace: 'traefik',
    sectionName: 'websecure',
};

/** Gateway serving internet-facing routes, restricted to opted-in namespaces. */
const publicGatewayRef = {
    name: 'traefik-gateway-public',
    namespace: 'traefik',
    sectionName: 'publicwebsecure',
};

export class TraefikNetwork implements RoutingProvider {
    privateEndpoints: Record<string, pulumi.Input<string>> = {};
    publicEndpoints: Record<string, pulumi.Input<string>> = {};
    customDomain: pulumi.Input<string>;
    readonly routeMiddlewareName?: string;

    constructor(
        private appName: string,
        private args: RoutingProviderArgs,
        private opts?: pulumi.ComponentResourceOptions,
    ) {
        this.customDomain = this.resolveCustomDomain();
        this.routeMiddlewareName = createRouteMiddleware(
            {
                appName: this.appName,
                namespace: this.args.metadata.namespace,
                oidc: this.args.oidc
                    ? { config: this.args.oidc, pluginSecret: this.args.pluginSecret }
                    : undefined,
                requestHeaders: this.args.routeRequestHeaders,
            },
            { parent: this.opts?.parent },
        )?.name;
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
            gatewayRef: privateGatewayRef,
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
                                match:
                                    spec.pathPrefix === undefined
                                        ? pulumi.interpolate`Host(\`${spec.hostname}\`)`
                                        : pulumi.interpolate`Host(\`${spec.hostname}\`) && PathPrefix(\`${spec.pathPrefix}\`)`,
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
                            ...(spec.pathPrefix === undefined
                                ? {}
                                : {
                                      matches: [
                                          {
                                              path: {
                                                  type: 'PathPrefix',
                                                  value: spec.pathPrefix,
                                              },
                                          },
                                      ],
                                  }),
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

    createHttpRedirect(
        spec: HttpRedirectSpec,
        opts?: pulumi.CustomResourceOptions,
    ): void {
        const metadata = this.args.metadata.get({ component: spec.componentName });
        // Gateway API expresses the target as separate fields, so the caller's
        // single URL has to be taken apart. Done inside `apply` because the
        // target may be an Output resolved from config.
        const target = pulumi.output(spec.to).apply(url => {
            const parsed = new URL(url);
            return {
                scheme: parsed.protocol.replace(':', ''),
                hostname: parsed.hostname,
                path: parsed.pathname,
            };
        });
        new kubernetes.apiextensions.CustomResource(
            `${metadata.name}-redirect`,
            {
                apiVersion: 'gateway.networking.k8s.io/v1',
                kind: 'HTTPRoute',
                metadata: { ...metadata, name: `${metadata.name}-redirect` },
                spec: {
                    parentRefs: [
                        { ...privateGatewayRef },
                        ...(spec.public ? [{ ...publicGatewayRef }] : []),
                    ],
                    hostnames: [spec.hostname],
                    rules: [
                        {
                            matches: [
                                {
                                    path: { type: 'Exact', value: spec.path },
                                },
                            ],
                            filters: [
                                {
                                    type: 'RequestRedirect',
                                    requestRedirect: {
                                        scheme: target.scheme,
                                        hostname: target.hostname,
                                        path: {
                                            type: 'ReplaceFullPath',
                                            replaceFullPath: target.path,
                                        },
                                        statusCode:
                                            spec.permanent === false ? 302 : 301,
                                    },
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
        public?: boolean;
        apexDomain?: boolean;
    }): void {
        params.httpPorts.forEach(portSpec => {
            const portHostname = portSpec.hostname ?? params.hostname;
            const httpEndpointInfo = this.getHttpEndpointInfo(portHostname);
            const portComponentName = [params.component, portSpec.name]
                .filter(Boolean)
                .join('-');
            const hostnames: (string | pulumi.Input<string>)[] = [
                httpEndpointInfo.hostname,
                // The apex owner also answers on the bare custom domain.
                ...(params.apexDomain ? [this.customDomain] : []),
            ];

            this.createHttpBackendRoute({
                hostnames,
                componentName: portComponentName,
                serviceName: params.serviceName,
                servicePort: portSpec.port,
                middlewareName: params.middlewareName,
            });
            if (params.public) {
                this.createHttpBackendRoute({
                    hostnames,
                    componentName: `${portComponentName}-public`,
                    serviceName: params.serviceName,
                    servicePort: portSpec.port,
                    middlewareName: params.middlewareName,
                    parentRef: publicGatewayRef,
                });
            }
        });
        this.exportHttpEndpoints(params);
    }

    /**
     * Creates an HTTPRoute for one set of hostnames. `hostnames` already contains
     * the resolved name, so the same route can serve an app's own name alongside
     * any additional ones.
     */
    private createHttpBackendRoute(params: {
        hostnames: pulumi.Input<pulumi.Input<string>[]>;
        componentName: string;
        serviceName: pulumi.Input<string>;
        servicePort: number;
        middlewareName?: string;
        parentRef?: { name: string; namespace: string; sectionName: string };
    }): void {
        const metadata = this.args.metadata.get({ component: params.componentName });
        new kubernetes.apiextensions.CustomResource(
            `${metadata.name}-httproute`,
            {
                apiVersion: 'gateway.networking.k8s.io/v1',
                kind: 'HTTPRoute',
                metadata,
                spec: {
                    parentRefs: [params.parentRef ?? privateGatewayRef],
                    hostnames: params.hostnames,
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
        public?: boolean;
    }): kubernetes.core.v1.Service | undefined {
        if (params.tcpPorts.length === 0) return undefined;

        const hostname = pulumi.interpolate`${params.hostname}.${this.customDomain}`;
        const lbPorts = params.tcpPorts.filter(
            p => p.protocol === 'tcp' || p.protocol === 'udp',
        );
        const publicPorts = params.public ? lbPorts.filter(p => p.public) : [];

        this.createTlsRoutes({
            component: params.component,
            tlsPorts: params.tcpPorts.filter(p => p.protocol === 'tls'),
            serviceName: params.serviceName,
            hostname,
        });
        const loadBalancer = this.createLoadBalancer({
            component: params.component,
            ports: lbPorts,
            nameSuffix: '-lb',
            externalTrafficPolicy: params.externalTrafficPolicy,
        });
        this.createLoadBalancer({
            component: params.component,
            ports: publicPorts,
            nameSuffix: '-public-lb',
            externalTrafficPolicy: params.externalTrafficPolicy,
            publicPorts: true,
        });

        this.exportTcpEndpoints({
            component: params.component,
            tcpPorts: params.tcpPorts,
            hostname,
            publicPorts,
        });

        return loadBalancer;
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

    /**
     * A LoadBalancer Service for a component's TCP/UDP ports. Public ports are
     * published on `<port> + publicPortOffset`, leaving the port's own number
     * for private reach.
     */
    private createLoadBalancer(params: {
        component?: string;
        ports: ServicePort[];
        nameSuffix: string;
        externalTrafficPolicy?: 'Local' | 'Cluster';
        publicPorts?: boolean;
    }): kubernetes.core.v1.Service | undefined {
        if (params.ports.length === 0) return undefined;
        const metadata = this.args.metadata.get({ component: params.component });
        const name = `${metadata.name}${params.nameSuffix}`;

        return new kubernetes.core.v1.Service(
            name,
            {
                metadata: { ...metadata, name },
                spec: {
                    type: 'LoadBalancer',
                    externalTrafficPolicy: params.externalTrafficPolicy,
                    ports: params.ports.map(p => ({
                        name: p.name,
                        protocol: p.protocol === 'udp' ? 'UDP' : 'TCP',
                        port: params.publicPorts ? this.publicPort(p.port) : p.port,
                        targetPort: p.port,
                    })),
                    selector: this.args.metadata.getSelectorLabels(params.component),
                },
            },
            {
                ...this.opts,
                deleteBeforeReplace: true,
            },
        );
    }

    private publicPort(port: number): number {
        const mapped = port + publicPortOffset;
        if (mapped > 65535) {
            throw new Error(
                `${this.appName}: public port ${String(port)} maps to ${String(mapped)}, above the maximum 65535.`,
            );
        }
        return mapped;
    }

    private exportHttpEndpoints(params: {
        component?: string;
        httpPorts: ServicePort[];
        hostname: string;
        serviceName: pulumi.Input<string>;
        public?: boolean;
    }): void {
        params.httpPorts.forEach(port => {
            const portHostname = port.hostname ?? params.hostname;
            const httpEndpointInfo = this.getHttpEndpointInfo(portHostname);
            const key = this.getEndpointKey({
                component: params.component,
                portName: port.name,
            });
            const bucket = params.public
                ? this.publicEndpoints
                : this.privateEndpoints;
            bucket[key] = pulumi.interpolate`https://${httpEndpointInfo.hostname}`;
        });
    }

    private exportTcpEndpoints(params: {
        component?: string;
        tcpPorts: ServicePort[];
        hostname: pulumi.Input<string>;
        publicPorts: ServicePort[];
    }): void {
        params.tcpPorts.forEach(port => {
            const key = this.getEndpointKey({
                component: params.component,
                portName: port.name,
            });
            const isPublic = params.publicPorts.includes(port);
            const bucket = isPublic
                ? this.publicEndpoints
                : this.privateEndpoints;
            bucket[key] =
                port.protocol === 'tls'
                    ? pulumi.interpolate`${params.hostname}:3443`
                    : pulumi.interpolate`${params.hostname}:${
                          isPublic ? this.publicPort(port.port) : port.port
                      }`;
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
