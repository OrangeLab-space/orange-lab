import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import assert from 'node:assert';
import { config } from './config';
import { Metadata } from './metadata';
import {
    HttpEndpointInfo,
    HttpRouteSpec,
    PublicTcpServiceConfig,
    RoutingProvider,
    ServicePort,
} from './types';

export class TailscaleNetwork implements RoutingProvider {
    endpoints: Record<string, pulumi.Input<string>> = {};
    tailnetDomain: string;

    constructor(
        private appName: string,
        private args: { metadata: Metadata },
        private opts?: pulumi.ComponentResourceOptions,
    ) {
        assert(
            config.isEnabled('tailscale'),
            `${this.appName}: Tailscale Operator has to be installed (tailscale:enabled=true)`,
        );
        this.tailnetDomain = config.require('tailscale', 'tailnet');
    }

    getHttpEndpointInfo(hostname: string): HttpEndpointInfo {
        return {
            className: 'tailscale',
            host: hostname,
            hostname,
            url: `https://${hostname}.${this.tailnetDomain}`,
            tls: true,
            domain: this.tailnetDomain,
        };
    }

    getPublicTcpService(params: { hostname: string }): PublicTcpServiceConfig {
        return {
            type: 'LoadBalancer',
            loadBalancerClass: 'tailscale',
            annotations: { 'tailscale.com/hostname': params.hostname },
        };
    }

    createHttpRoute(
        _spec: HttpRouteSpec,
        _opts?: pulumi.CustomResourceOptions,
    ): void {
        assert(
            false,
            `${this.appName}: OIDC-protected routes require the Traefik routing provider.`,
        );
    }

    createHttpEndpoints(params: {
        serviceName: pulumi.Input<string>;
        httpPorts: ServicePort[];
        component?: string;
        hostname: string;
        middlewareName?: string;
    }): void {
        assert(
            !params.middlewareName,
            `${this.appName}: OIDC-protected routes require the Traefik routing provider.`,
        );
        params.httpPorts.forEach(httpPort => {
            const httpEndpointInfo = this.getHttpEndpointInfo(
                httpPort.hostname ?? params.hostname,
            );
            const componentName = [params.component, httpPort.name]
                .filter(Boolean)
                .join('-');

            this.createIngress({
                componentName,
                httpEndpointInfo,
                serviceName: params.serviceName,
                servicePort: httpPort,
            });
        });
        this.exportHttpEndpoints(params);
    }

    private createIngress(params: {
        componentName: string;
        httpEndpointInfo: HttpEndpointInfo;
        serviceName: pulumi.Input<string>;
        servicePort: ServicePort;
    }): void {
        const metadata = this.args.metadata.get({ component: params.componentName });
        new kubernetes.networking.v1.Ingress(
            `${metadata.name}-ingress`,
            {
                metadata,
                spec: {
                    ingressClassName: params.httpEndpointInfo.className,
                    tls: [
                        {
                            hosts: [params.httpEndpointInfo.hostname],
                            secretName: params.httpEndpointInfo.tlsSecretName,
                        },
                    ],
                    rules: [
                        {
                            host: params.httpEndpointInfo.hostname,
                            http: {
                                paths: [
                                    {
                                        path: '/',
                                        pathType: 'Prefix',
                                        backend: {
                                            service: {
                                                name: params.serviceName,
                                                port: { number: params.servicePort.port },
                                            },
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            },
            {
                ...this.opts,
                aliases: [
                    { name: `${metadata.name}-ingress` },
                    { name: `${metadata.name}-traefik-ingress` },
                ],
            },
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

        this.createTcpLoadBalancer({
            component: params.component,
            tcpPorts: params.tcpPorts,
            hostname: params.hostname,
            externalTrafficPolicy: params.externalTrafficPolicy,
        });

        this.exportTcpEndpoints({
            component: params.component,
            tcpPorts: params.tcpPorts,
            hostname: params.hostname,
        });
    }

    private createTcpLoadBalancer(params: {
        component?: string;
        tcpPorts: ServicePort[];
        hostname: string;
        externalTrafficPolicy?: 'Local' | 'Cluster';
    }): kubernetes.core.v1.Service {
        const metadata = this.args.metadata.get({ component: params.component });
        return new kubernetes.core.v1.Service(
            `${metadata.name}-ts-lb`,
            {
                metadata: {
                    ...metadata,
                    annotations: { 'tailscale.com/hostname': params.hostname },
                },
                spec: {
                    type: 'LoadBalancer',
                    loadBalancerClass: 'tailscale',
                    externalTrafficPolicy: params.externalTrafficPolicy,
                    ports: params.tcpPorts.map(p => ({
                        name: p.name,
                        protocol: p.protocol === 'udp' ? 'UDP' : 'TCP',
                        port: p.port,
                        targetPort: p.port,
                    })),
                    selector: this.args.metadata.getSelectorLabels(params.component),
                },
            },
            {
                ...this.opts,
                aliases: [{ name: `${metadata.name}-lb` }],
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
        hostname: string;
    }): void {
        params.tcpPorts.forEach(port => {
            const key = this.getEndpointKey({
                component: params.component,
                portName: port.name,
            });
            this.endpoints[key] = pulumi.interpolate`${params.hostname}:${port.port}`;
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
}
