import { Application, config, createPassword } from '@orangelab/pulumi';
import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { ModelCostCatalog } from './model-catalog';
import { ProviderModels } from './providers';
import { VirtualModels } from './virtual-models';

const chartRepo = 'oci://cr.agentgateway.dev/charts';
const gatewayName = 'agentgateway-proxy';
const uiPort = 15001;
const uiProxyCaddyfile = `{
    admin off
}
:${String(uiPort)} {
    @ui path /ui /ui/*
    handle @ui {
        reverse_proxy 127.0.0.1:15000
    }
    @api path /api /api/*
    handle @api {
        reverse_proxy 127.0.0.1:15000
    }
    @configDump path /config_dump
    handle @configDump {
        reverse_proxy 127.0.0.1:15000
    }
    redir / /ui/ 302
    respond 404
}`;
const uiProxyCaddyfileHash = createHash('sha256').update(uiProxyCaddyfile).digest('hex');

interface AgentgatewayLinks {
    analytics: pulumi.Output<string>;
    api: pulumi.Output<string>;
    dashboard: pulumi.Output<string>;
    logs: pulumi.Output<string>;
}

export interface AgentgatewayArgs {
    /**
     * Providers whose credential the gateway mints itself, for providers hosted by
     * another component in this stack. Names use the same key as
     * `agentgateway:providers`; a name that no provider declares is ignored, so a
     * stack can run that component without routing it through the gateway.
     */
    generatedProviderKeys?: string[];
}

export class Agentgateway extends pulumi.ComponentResource {
    public readonly apiKeys: Record<string, pulumi.Output<string>>;

    public readonly apiUrl: pulumi.Output<string>;

    public readonly app: Application;

    public readonly links: AgentgatewayLinks;

    /** Credentials minted for `generatedProviderKeys`, for the hosting component. */
    public readonly providerApiKeys: Record<string, pulumi.Input<string>>;

    constructor(
        private readonly name: string,
        args: AgentgatewayArgs = {},
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:ai:Agentgateway', name, {}, opts);

        this.assertTraefik();
        this.app = new Application(this, name, { oidc: { protectRoutes: true } });

        const clients = config.requireCommaSeparated(name, 'clients');
        this.apiKeys = this.createApiKeys(clients);
        this.providerApiKeys = this.createProviderKeys(args.generatedProviderKeys ?? []);
        const requestHeaders = this.parseRequestHeaders();

        const crds = this.installCrds();
        const controller = this.installController(crds);
        const uiConfig = this.createUiConfig();
        const namespace = this.app.metadata.namespace;
        const providers = new ProviderModels(
            name,
            namespace,
            gatewayName,
            this,
            this.providerApiKeys,
        );
        const virtualModels = new VirtualModels(
            name,
            namespace,
            gatewayName,
            this,
            providers.specs,
        );
        const costCatalog = new ModelCostCatalog(name, namespace, this);
        const gateway = this.createGateway(controller, uiConfig, costCatalog);
        const modelResources = providers.createModels(gateway);
        virtualModels.createResources(gateway, modelResources);
        this.createApiKeyConfigMap(gateway, clients);
        this.createPolicy(gateway, requestHeaders);
        const ui = this.createDashboard(gateway);

        this.apiUrl = pulumi.interpolate`http://${gatewayName}.${this.app.metadata.namespace}.svc.cluster.local/v1`;
        this.links = this.createRoutes(ui);
    }

    private assertTraefik(): void {
        const provider =
            config.get(this.name, 'routingProvider') ??
            config.get('orangelab', 'routingProvider');
        assert(
            provider === 'traefik',
            `${this.name}: requires orangelab:routingProvider traefik.`,
        );
    }

    private createApiKeys(clients: string[]): Record<string, pulumi.Output<string>> {
        return Object.fromEntries(
            clients.map(client => [
                client,
                createPassword(this, `${this.name}-${client}-key`, { length: 40 }),
            ]),
        );
    }

    private createProviderKeys(
        providers: string[],
    ): Record<string, pulumi.Input<string>> {
        return Object.fromEntries(
            providers.map(provider => [
                provider,
                createPassword(this, `${this.name}-${provider}-provider-key`, {
                    length: 48,
                }),
            ]),
        );
    }

    /**
     * Upstream request headers applied when the client does not send one. Some
     * providers require a header for routing; OpenCode Go needs
     * `x-opencode-session`, which agents send but plain chat clients do not.
     */
    private parseRequestHeaders(): Record<string, string> {
        const raw = config.getObject(this.name, 'requestHeaders');
        if (raw === undefined) return {};
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            throw new Error(
                `${this.name}:requestHeaders must map header names to values.`,
            );
        }
        return Object.fromEntries(
            Object.entries(raw as Record<string, unknown>).map(([header, value]) => {
                if (!/^[a-z0-9-]+$/i.test(header)) {
                    throw new Error(
                        `${this.name}:requestHeaders has invalid header name '${header}'.`,
                    );
                }
                if (typeof value !== 'string' || !value) {
                    throw new Error(
                        `${this.name}:requestHeaders.${header} must be a non-empty string.`,
                    );
                }
                return [header, value];
            }),
        );
    }

    private installCrds(): kubernetes.helm.v3.Release {
        return this.app.addHelmChart(`${this.name}-crds`, {
            chart: 'agentgateway-crds',
            repo: chartRepo,
        });
    }

    private installController(
        crds: kubernetes.helm.v3.Release,
    ): kubernetes.helm.v3.Release {
        return this.app.addHelmChart(
            this.name,
            {
                chart: 'agentgateway',
                repo: chartRepo,
                values: {
                    monitoring: config.enableMonitoring() ? { enabled: true } : undefined,
                },
            },
            { dependsOn: [crds] },
        );
    }

    private createUiConfig(): kubernetes.core.v1.ConfigMap {
        const name = `${this.name}-ui-proxy-${uiProxyCaddyfileHash.slice(0, 8)}`;
        return new kubernetes.core.v1.ConfigMap(
            name,
            {
                data: { Caddyfile: uiProxyCaddyfile },
                metadata: {
                    name,
                    namespace: this.app.metadata.namespace,
                },
            },
            { parent: this },
        );
    }

    private createGateway(
        controller: kubernetes.helm.v3.Release,
        uiConfig: kubernetes.core.v1.ConfigMap,
        costCatalog: ModelCostCatalog,
    ): kubernetes.apiextensions.CustomResource {
        const namespace = this.app.metadata.namespace;
        const parametersName = `${this.name}-parameters`;
        const modelCatalog = costCatalog.modelCatalog;

        new kubernetes.apiextensions.CustomResource(
            parametersName,
            {
                apiVersion: 'agentgateway.dev/v1alpha1',
                kind: 'AgentgatewayParameters',
                metadata: { name: parametersName, namespace },
                spec: {
                    env: [{ name: 'UI_READ_ONLY', value: 'true' }],
                    deployment: {
                        spec: {
                            template: {
                                metadata: {
                                    annotations: {
                                        'orangelab/checksum-ui-proxy':
                                            uiProxyCaddyfileHash,
                                    },
                                },
                                spec: {
                                    containers: [
                                        {
                                            env: [
                                                {
                                                    name: 'XDG_CONFIG_HOME',
                                                    value: '/config',
                                                },
                                                { name: 'XDG_DATA_HOME', value: '/data' },
                                            ],
                                            image: 'caddy:2-alpine',
                                            name: 'ui-proxy',
                                            ports: [
                                                { containerPort: uiPort, name: 'ui' },
                                            ],
                                            resources: {
                                                limits: { memory: '64Mi' },
                                                requests: { cpu: '10m', memory: '16Mi' },
                                            },
                                            securityContext: {
                                                allowPrivilegeEscalation: false,
                                                capabilities: {
                                                    add: ['NET_BIND_SERVICE'],
                                                    drop: ['ALL'],
                                                },
                                                readOnlyRootFilesystem: true,
                                            },
                                            volumeMounts: [
                                                {
                                                    mountPath: '/etc/caddy',
                                                    name: 'ui-proxy-config',
                                                    readOnly: true,
                                                },
                                                {
                                                    mountPath: '/data',
                                                    name: 'ui-proxy-data',
                                                },
                                                {
                                                    mountPath: '/config',
                                                    name: 'ui-proxy-config-dir',
                                                },
                                                {
                                                    mountPath: '/tmp',
                                                    name: 'ui-proxy-tmp',
                                                },
                                            ],
                                        },
                                    ],
                                    volumes: [
                                        {
                                            configMap: { name: uiConfig.metadata.name },
                                            name: 'ui-proxy-config',
                                        },
                                        { emptyDir: {}, name: 'ui-proxy-data' },
                                        { emptyDir: {}, name: 'ui-proxy-config-dir' },
                                        { emptyDir: {}, name: 'ui-proxy-tmp' },
                                    ],
                                },
                            },
                        },
                    },
                    ...(modelCatalog ? { modelCatalog } : {}),
                    rawConfig: {
                        config: {
                            database: {
                                url: 'sqlite:////tmp/agentgateway.db?mode=rwc',
                            },
                        },
                        frontendPolicies: {
                            accessLog: {
                                database: { llm: 'full' },
                            },
                        },
                    },
                    service: { spec: { type: 'ClusterIP' } },
                },
            },
            {
                dependsOn: costCatalog.configMap
                    ? [controller, uiConfig, costCatalog.configMap]
                    : [controller, uiConfig],
                parent: this,
            },
        );

        return new kubernetes.apiextensions.CustomResource(
            `${this.name}-gateway`,
            {
                apiVersion: 'gateway.networking.k8s.io/v1',
                kind: 'Gateway',
                metadata: { name: gatewayName, namespace },
                spec: {
                    gatewayClassName: 'agentgateway',
                    infrastructure: {
                        parametersRef: {
                            group: 'agentgateway.dev',
                            kind: 'AgentgatewayParameters',
                            name: parametersName,
                        },
                    },
                    listeners: [
                        {
                            allowedRoutes: {
                                kinds: [
                                    {
                                        group: 'gateway.networking.k8s.io',
                                        kind: 'HTTPRoute',
                                    },
                                    {
                                        group: 'agentgateway.dev',
                                        kind: 'AgentgatewayModel',
                                    },
                                ],
                                namespaces: { from: 'All' },
                            },
                            name: 'http',
                            port: 80,
                            protocol: 'HTTP',
                        },
                    ],
                },
            },
            { dependsOn: [controller], parent: this },
        );
    }

    private createApiKeyConfigMap(gateway: pulumi.Resource, clients: string[]): void {
        const data = pulumi
            .all(clients.map(client => this.apiKeys[client]))
            .apply(values => {
                const entries: Record<string, string> = {};
                values.forEach((value, index) => {
                    entries[clients[index]] = JSON.stringify({
                        keyHash: `sha256:${createHash('sha256').update(value).digest('hex')}`,
                        metadata: { user_id: clients[index] },
                    });
                });
                return entries;
            });

        new kubernetes.core.v1.ConfigMap(
            `${this.name}-api-keys`,
            {
                data,
                metadata: {
                    labels: { 'agentgateway.dev/apikey': 'true' },
                    name: `${this.name}-api-keys`,
                    namespace: this.app.metadata.namespace,
                },
            },
            { dependsOn: [gateway], parent: this },
        );
    }

    private createPolicy(
        gateway: pulumi.Resource,
        requestHeaders: Record<string, string>,
    ): void {
        const headers = Object.entries(requestHeaders).map(([name, value]) => ({
            name,
            value: `default(request.headers["${name}"], ${celString(value)})`,
        }));
        new kubernetes.apiextensions.CustomResource(
            `${this.name}-policy`,
            {
                apiVersion: 'agentgateway.dev/v1alpha1',
                kind: 'AgentgatewayPolicy',
                metadata: {
                    name: `${this.name}-api`,
                    namespace: this.app.metadata.namespace,
                },
                spec: {
                    targetRefs: [
                        {
                            group: 'gateway.networking.k8s.io',
                            kind: 'Gateway',
                            name: gatewayName,
                        },
                    ],
                    traffic: {
                        apiKeyAuthentication: {
                            configMapSelector: {
                                matchLabels: { 'agentgateway.dev/apikey': 'true' },
                            },
                            mode: 'Strict',
                        },
                        ...(headers.length > 0
                            ? { transformation: { request: { set: headers } } }
                            : {}),
                    },
                },
            },
            { dependsOn: [gateway], parent: this },
        );
    }

    private createDashboard(gateway: pulumi.Resource): kubernetes.core.v1.Service {
        return new kubernetes.core.v1.Service(
            `${this.name}-ui`,
            {
                metadata: {
                    name: `${this.name}-ui`,
                    namespace: this.app.metadata.namespace,
                },
                spec: {
                    ports: [{ name: 'ui', port: uiPort, targetPort: uiPort }],
                    selector: { 'gateway.networking.k8s.io/gateway-name': gatewayName },
                },
            },
            { dependsOn: [gateway], parent: this },
        );
    }

    private createRoutes(ui: kubernetes.core.v1.Service): AgentgatewayLinks {
        const apiEndpoint = this.app.network.getHttpEndpointInfo(
            config.require(this.name, 'hostname-llm'),
        );
        const uiEndpoint = this.app.network.getHttpEndpointInfo();

        this.app.network.createHttpRoute({
            componentName: 'api',
            hostname: apiEndpoint.hostname,
            serviceName: gatewayName,
            servicePort: 80,
        });
        this.app.network.createHttpRoute({
            componentName: 'ui',
            hostname: uiEndpoint.hostname,
            middlewareName: this.app.network.routeMiddlewareName,
            serviceName: ui.metadata.name,
            servicePort: uiPort,
        });

        this.app.network.addEndpoint('ai', pulumi.interpolate`${apiEndpoint.url}/v1`);
        this.app.network.addEndpoint('agentgateway', uiEndpoint.url);
        this.app.network.addClusterEndpoint('ai', this.apiUrl);

        return {
            analytics: pulumi.interpolate`${uiEndpoint.url}/ui/llm/analytics`,
            api: pulumi.interpolate`${apiEndpoint.url}/v1`,
            dashboard: pulumi.output(uiEndpoint.url),
            logs: pulumi.interpolate`${uiEndpoint.url}/ui/llm/logs`,
        };
    }
}

/** Quotes a value for use as a CEL string literal. */
function celString(value: string): string {
    return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
