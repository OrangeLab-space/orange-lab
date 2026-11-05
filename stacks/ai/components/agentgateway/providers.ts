import { config } from '@orangelab/pulumi';
import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

export interface ProviderSpec {
    baseUrl: string;
    /**
     * Client-facing prefix of the model ids (`<prefix>/<model>`). Defaults to the
     * provider name; set it to group several providers under one name, e.g. one
     * provider per Hermes profile all reachable as `hermes/<profile>`.
     */
    clientPrefix: string;
    models: string[];
    name: string;
}

export class ProviderModels {
    public readonly specs: ProviderSpec[];
    private readonly secrets: Map<string, kubernetes.core.v1.Secret>;

    constructor(
        private readonly appName: string,
        private readonly namespace: pulumi.Input<string>,
        private readonly gatewayName: string,
        private readonly parent: pulumi.Resource,
        /**
         * Credentials the gateway mints for providers hosted by another component,
         * keyed by provider name. A name no provider declares is ignored: the
         * hosting component may be enabled without being routed through the gateway.
         */
        private readonly generatedKeys: Record<string, pulumi.Input<string>> = {},
    ) {
        this.specs = this.parseProviders();
        this.secrets = this.createSecrets();
    }

    createModels(gateway: pulumi.Resource): kubernetes.apiextensions.CustomResource[] {
        const resources: kubernetes.apiextensions.CustomResource[] = [];
        for (const provider of this.specs) {
            const providerSecret = this.secrets.get(provider.name);
            for (const model of provider.models) {
                const clientName = `${provider.clientPrefix}/${model}`;
                resources.push(
                    new kubernetes.apiextensions.CustomResource(
                        toResourceName(`${this.appName}-model-${provider.name}-${model}`),
                        {
                            apiVersion: 'agentgateway.dev/v1alpha1',
                            kind: 'AgentgatewayModel',
                            metadata: {
                                name: toResourceName(`${provider.name}-${model}`),
                                namespace: this.namespace,
                            },
                            spec: {
                                baseURL: provider.baseUrl,
                                match: { model: clientName },
                                parentRefs: [
                                    {
                                        group: 'gateway.networking.k8s.io',
                                        kind: 'Gateway',
                                        name: this.gatewayName,
                                        sectionName: 'http',
                                    },
                                ],
                                policies: {
                                    ...(providerSecret
                                        ? {
                                              auth: {
                                                  secretRef: {
                                                      name: providerSecret.metadata.name,
                                                  },
                                              },
                                          }
                                        : {}),
                                    transformations: [
                                        {
                                            expression: `llmRequest.model.stripPrefix("${provider.clientPrefix}/")`,
                                            field: 'model',
                                        },
                                    ],
                                },
                                provider: 'OpenAI',
                            },
                        },
                        {
                            dependsOn: providerSecret
                                ? [gateway, providerSecret]
                                : [gateway],
                            parent: this.parent,
                        },
                    ),
                );
            }
        }
        return resources;
    }

    private parseProviders(): ProviderSpec[] {
        const raw = config.requireObject(this.appName, 'providers');
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            throw new Error(
                `${this.appName}:providers must map provider names to {baseUrl, models}.`,
            );
        }

        const providers = Object.entries(raw as Record<string, unknown>)
            .map(([name, value]) => {
                if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
                    throw new Error(
                        `${this.appName}:providers has invalid name '${name}'.`,
                    );
                }
                if (typeof value !== 'object' || value === null || Array.isArray(value)) {
                    throw new Error(
                        `${this.appName}:providers.${name} must be an object.`,
                    );
                }
                const { baseUrl, clientPrefix, models } = value as Record<
                    string,
                    unknown
                >;
                if (typeof baseUrl !== 'string' || !baseUrl) {
                    throw new Error(
                        `${this.appName}:providers.${name}.baseUrl must be a non-empty string.`,
                    );
                }
                if (
                    clientPrefix !== undefined &&
                    (typeof clientPrefix !== 'string' ||
                        !/^[a-z0-9][a-z0-9._-]*$/i.test(clientPrefix))
                ) {
                    throw new Error(
                        `${this.appName}:providers.${name}.clientPrefix must be a simple name.`,
                    );
                }
                if (
                    !Array.isArray(models) ||
                    models.length === 0 ||
                    models.some(model => typeof model !== 'string' || !model)
                ) {
                    throw new Error(
                        `${this.appName}:providers.${name}.models must be a non-empty list of model names.`,
                    );
                }
                return {
                    baseUrl: baseUrl.replace(/\/+$/, ''),
                    clientPrefix: clientPrefix ?? name,
                    models: models as string[],
                    name,
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name));

        if (providers.length === 0) {
            throw new Error(
                `${this.appName}:providers must contain at least one provider.`,
            );
        }

        const clientIds = new Map<string, string>();
        for (const provider of providers) {
            for (const model of provider.models) {
                const clientId = `${provider.clientPrefix}/${model}`;
                const owner = clientIds.get(clientId);
                if (owner) {
                    throw new Error(
                        `${this.appName}:providers.${owner} and providers.${provider.name} both publish '${clientId}'.`,
                    );
                }
                clientIds.set(clientId, provider.name);
            }
        }
        return providers;
    }

    private createSecrets(): Map<string, kubernetes.core.v1.Secret> {
        const secrets = new Map<string, kubernetes.core.v1.Secret>();
        for (const provider of this.specs) {
            const apiKey =
                this.generatedKeys[provider.name] ??
                config.getSecret(this.appName, `${provider.name}/apiKey`);
            if (!apiKey) continue;
            secrets.set(
                provider.name,
                new kubernetes.core.v1.Secret(
                    `${this.appName}-${provider.name}`,
                    {
                        metadata: {
                            name: `${this.appName}-${provider.name}`,
                            namespace: this.namespace,
                        },
                        stringData: { Authorization: apiKey },
                        type: 'Opaque',
                    },
                    { parent: this.parent },
                ),
            );
        }
        return secrets;
    }
}

export function toResourceName(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}
