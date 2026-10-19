import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { OidcAuthConfig } from './auth';
import { config } from './config';
import { Metadata } from './metadata';
import { createTraefikOidcMiddleware, traefikOidcMiddlewareName } from './oidc-auth';
import { TailscaleNetwork } from './network-tailscale';
import { TraefikNetwork } from './network-traefik';
import {
    ContainerSpec,
    HttpEndpointInfo,
    HttpRedirectSpec,
    HttpRouteSpec,
    PublicTcpServiceConfig,
    RoutingProvider,
    ServicePort,
} from './types';

/**
 * Namespace label opting an application into public routing. The public Gateway
 * only accepts routes from namespaces carrying this label, so exposure is
 * explicit rather than incidental.
 */
export const publicNamespaceLabel = 'orangelab.space/public';

/**
 * Endpoints of one or more applications, grouped by reach. A stack export puts
 * these under `endpoints`, so a caller asks for `.public` or `.private` rather
 * than guessing which one an application landed in. A group with nothing in it
 * is omitted rather than exported empty.
 */
export type EndpointExports = Partial<
    Record<'public' | 'private' | 'cluster', Record<string, pulumi.Input<string>>>
>;

/**
 * Combine the endpoints of several applications into a single export. Endpoint
 * keys already carry the application name, so the groups do not collide.
 */
export function mergeEndpointExports(
    ...apps: ({ app: { network: Pick<Network, 'getEndpointExports'> } } | undefined)[]
): EndpointExports {
    const merged: EndpointExports = {};
    for (const group of ['public', 'private', 'cluster'] as const) {
        for (const app of apps) {
            const endpoints = app?.app.network.getEndpointExports()[group];
            if (endpoints) {
                merged[group] = { ...merged[group], ...endpoints };
            }
        }
    }
    return merged;
}

/** Namespace labels for an application, given its public exposure setting. */
export function getNamespaceLabels(appName: string): Record<string, string> | undefined {
    return config.getBoolean(appName, 'network/public')
        ? { [publicNamespaceLabel]: 'true' }
        : undefined;
}

export class Network {
    privateEndpoints: Record<string, pulumi.Input<string>> = {};
    publicEndpoints: Record<string, pulumi.Input<string>> = {};
    clusterEndpoints: Record<string, pulumi.Input<string>> = {};
    private provider: RoutingProvider;
    private tcpLoadBalancer?: kubernetes.core.v1.Service;
    /** Whether the application is reachable from the internet. */
    readonly publiclyExposed: boolean;

    constructor(
        private appName: string,
        private args: {
            metadata: Metadata;
            pluginSecret?: pulumi.Input<string>;
            oidc?: OidcAuthConfig;
        },
        private opts?: pulumi.ComponentResourceOptions,
    ) {
        this.publiclyExposed = config.getBoolean(this.appName, 'network/public') ?? false;
        const routingProvider =
            config.get(this.appName, 'routingProvider') ??
            config.get('orangelab', 'routingProvider');
        switch (routingProvider) {
            case 'traefik':
                this.provider = new TraefikNetwork(appName, args, opts);
                break;
            case 'tailscale':
                this.provider = new TailscaleNetwork(appName, args, opts);
                break;
            default:
                throw new Error(
                    `Unknown orangelab:routingProvider: ${routingProvider ?? 'undefined'}. Must be 'traefik' or 'tailscale'.`,
                );
        }
        if (args.oidc !== undefined) {
            if (routingProvider !== 'traefik') {
                throw new Error(
                    `${appName}: OIDC-protected routes require the Traefik routing provider.`,
                );
            }
            if (args.pluginSecret === undefined) {
                throw new Error(`${appName}: OIDC plugin secret is not configured.`);
            }
            this.oidcMiddlewareName = traefikOidcMiddlewareName(appName);
            createTraefikOidcMiddleware(
                {
                    appName,
                    namespace: args.metadata.namespace,
                    oidc: args.oidc,
                    pluginSecret: args.pluginSecret,
                },
                { parent: opts?.parent },
            );
        }
    }

    readonly oidcMiddlewareName?: string;

    public getHttpEndpointInfo(
        hostname: string = config.require(this.appName, 'hostname'),
    ): HttpEndpointInfo {
        return this.provider.getHttpEndpointInfo(hostname);
    }

    getPublicTcpService(hostname: string): PublicTcpServiceConfig {
        return this.provider.getPublicTcpService({ hostname });
    }

    createHttpRoute(
        spec: HttpRouteSpec,
        opts?: pulumi.CustomResourceOptions,
    ) {
        this.provider.createHttpRoute(this.withRouteDefaults(spec), opts);
    }

    createHttpRedirect(
        spec: HttpRedirectSpec,
        opts?: pulumi.CustomResourceOptions,
    ) {
        this.provider.createHttpRedirect(
            {
                hostname: this.getHttpEndpointInfo().hostname,
                ...spec,
            },
            opts,
        );
    }

    /**
     * A route on the application's own hostname, pointing at the application's
     * own Service, is the common case and needs no arguments. Each omission
     * resolves to the value the application would have supplied anyway.
     */
    private withRouteDefaults(spec: HttpRouteSpec): HttpRouteSpec {
        return {
            hostname: this.getHttpEndpointInfo().hostname,
            serviceName: this.args.metadata.get().name,
            ...spec,
        };
    }

    createEndpoints(spec: ContainerSpec) {
        const ports = spec.ports ?? [];
        if (ports.length === 0) return;

        const service = this.createClusterService({
            component: spec.name,
            ports,
            clusterIP: spec.clusterIP,
        });
        this.exportClusterEndpoints({ service, component: spec.name, ports });

        const publicPorts = ports.filter(p => !p.private);
        if (publicPorts.length > 0) {
            const hostname = spec.hostname ?? this.getHostname(spec.name);
            const httpPorts = publicPorts.filter(
                p => !p.protocol || p.protocol === 'http',
            );
            if (httpPorts.length > 0) {
                this.provider.createHttpEndpoints({
                    serviceName: service.metadata.name,
                    httpPorts,
                    component: spec.name,
                    hostname,
                    middlewareName: this.oidcMiddlewareName,
                    public: this.publiclyExposed,
                    apexDomain: spec.apexDomain,
                });
            }
            const tcpPorts = publicPorts.filter(
                p => p.protocol === 'tcp' || p.protocol === 'tls' || p.protocol === 'udp',
            );
            if (tcpPorts.length > 0 && !spec.hostNetwork) {
                if (spec.apexDomain) {
                    throw new Error(
                        `${this.appName}: apexDomain serves the bare custom domain, which supports HTTP only.`,
                    );
                }
                const loadBalancer = this.provider.createTcpEndpoints({
                    serviceName: service.metadata.name,
                    tcpPorts,
                    component: spec.name,
                    hostname,
                    externalTrafficPolicy: spec.externalTrafficPolicy,
                    public: this.publiclyExposed,
                });
                if (loadBalancer) this.tcpLoadBalancer = loadBalancer;
            }
        }

        Object.assign(this.privateEndpoints, this.provider.privateEndpoints);
        Object.assign(this.publicEndpoints, this.provider.publicEndpoints);
    }

    /**
     * Record an endpoint the automatic port handling cannot see — an
     * application served by a Helm chart, or one that suppresses its own route
     * and serves a path prefix. Such applications do not expose per-port
     * settings, so its endpoints follow the application's `network/public`.
     */
    addEndpoint(name: string, url: pulumi.Input<string>): void {
        const bucket = this.publiclyExposed
            ? this.publicEndpoints
            : this.privateEndpoints;
        bucket[name] = url;
    }

    /**
     * Record an in-cluster endpoint derived from one already registered — a
     * websocket URL built from a Service address, say.
     */
    addClusterEndpoint(name: string, url: pulumi.Input<string>): void {
        this.clusterEndpoints[name] = url;
    }

    /**
     * Endpoints grouped by where they are reachable. `public` holds the
     * endpoints reachable from the internet, `private` the ones only the
     * tailnet reaches, `cluster` the in-cluster Service addresses.
     */
    getEndpointExports(): EndpointExports {
        const exports: EndpointExports = {};
        if (Object.keys(this.publicEndpoints).length > 0) {
            exports.public = this.publicEndpoints;
        }
        if (Object.keys(this.privateEndpoints).length > 0) {
            exports.private = this.privateEndpoints;
        }
        if (Object.keys(this.clusterEndpoints).length > 0) {
            exports.cluster = this.clusterEndpoints;
        }
        return exports;
    }

    /**
     * External IP of the TCP load balancer, once the platform assigns one.
     * Undefined when the app exposes no TCP/UDP ports or runs hostNetwork.
     * (The SDK types these status fields as always present; the cast reflects
     * their actual absence before assignment.)
     */
    getTcpLoadBalancerIp(): pulumi.Output<string | undefined> | undefined {
        return this.tcpLoadBalancer?.status.apply(
            status =>
                (
                    status as unknown as {
                        loadBalancer?: { ingress?: { ip?: string }[] };
                    }
                ).loadBalancer?.ingress?.[0]?.ip,
        );
    }

    private getHostname(component?: string) {
        return component
            ? config.require(this.appName, `${component}/hostname`)
            : config.require(this.appName, 'hostname');
    }

    private createClusterService(args: {
        component?: string;
        ports: ServicePort[];
        clusterIP?: string;
    }): kubernetes.core.v1.Service {
        const metadata = this.args.metadata.get({ component: args.component });
        return new kubernetes.core.v1.Service(
            `${metadata.name}-svc`,
            {
                metadata,
                spec: {
                    type: 'ClusterIP',
                    clusterIP: args.clusterIP,
                    ports: args.ports.map(p => ({
                        name: p.name,
                        protocol: p.protocol === 'udp' ? 'UDP' : 'TCP',
                        port: p.port,
                        targetPort: p.port,
                    })),
                    selector: this.args.metadata.getSelectorLabels(args.component),
                },
            },
            this.opts,
        );
    }

    private exportClusterEndpoints(params: {
        service: kubernetes.core.v1.Service;
        component?: string;
        ports: ServicePort[];
    }): void {
        params.ports.forEach(port => {
            const key = this.getEndpointKey({
                component: params.component,
                portName: port.name,
            });
            const prefix = port.protocol && port.protocol !== 'http' ? '' : 'http://';
            this.clusterEndpoints[key] =
                pulumi.interpolate`${prefix}${params.service.metadata.name}.${this.args.metadata.namespace}:${port.port}`;
        });
    }

    private getEndpointKey(params: {
        component: string | undefined;
        portName: string;
    }): string {
        return [
            this.appName,
            params.component,
            params.portName === 'http' ? undefined : params.portName,
        ]
            .filter(Boolean)
            .join('-');
    }
}
