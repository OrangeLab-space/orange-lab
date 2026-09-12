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
    HttpRouteSpec,
    PublicTcpServiceConfig,
    RoutingProvider,
    ServicePort,
} from './types';

export class Network {
    endpoints: Record<string, pulumi.Input<string>> = {};
    clusterEndpoints: Record<string, pulumi.Input<string>> = {};
    private provider: RoutingProvider;

    constructor(
        private appName: string,
        private args: {
            metadata: Metadata;
            pluginSecret?: pulumi.Input<string>;
            oidc?: OidcAuthConfig;
        },
        private opts?: pulumi.ComponentResourceOptions,
    ) {
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
        this.provider.createHttpRoute(spec, opts);
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
                });
            }
            const tcpPorts = publicPorts.filter(
                p => p.protocol === 'tcp' || p.protocol === 'tls' || p.protocol === 'udp',
            );
            if (tcpPorts.length > 0 && !spec.hostNetwork) {
                this.provider.createTcpEndpoints({
                    serviceName: service.metadata.name,
                    tcpPorts,
                    component: spec.name,
                    hostname,
                    externalTrafficPolicy: spec.externalTrafficPolicy,
                });
            }
        }

        Object.assign(this.endpoints, this.provider.endpoints);
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
