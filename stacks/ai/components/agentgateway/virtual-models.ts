import { config } from '@orangelab/pulumi';
import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { ProviderSpec, toResourceName } from './providers';

type VirtualStrategy = 'failover' | 'weighted';

interface VirtualTarget {
    model: string;
    priority?: number;
    weight?: number;
}

interface VirtualModelSpec {
    name: string;
    strategy: VirtualStrategy;
    targets: VirtualTarget[];
}

export class VirtualModels {
    private readonly specs: VirtualModelSpec[];

    constructor(
        private readonly appName: string,
        private readonly namespace: pulumi.Input<string>,
        private readonly gatewayName: string,
        private readonly parent: pulumi.Resource,
        providers: ProviderSpec[],
    ) {
        this.specs = this.parseVirtualModels(providers);
    }

    createResources(
        gateway: pulumi.Resource,
        modelResources: kubernetes.apiextensions.CustomResource[],
    ): void {
        for (const virtual of this.specs) {
            new kubernetes.apiextensions.CustomResource(
                `${this.appName}-virtual-${virtual.name}`,
                {
                    apiVersion: 'agentgateway.dev/v1alpha1',
                    kind: 'AgentgatewayModel',
                    metadata: {
                        name: virtual.name,
                        namespace: this.namespace,
                    },
                    spec: {
                        parentRefs: [
                            {
                                group: 'gateway.networking.k8s.io',
                                kind: 'Gateway',
                                name: this.gatewayName,
                                sectionName: 'http',
                            },
                        ],
                        virtualModel: {
                            [virtual.strategy]: {
                                targets: virtual.targets.map(target => ({
                                    modelRef: {
                                        name: toResourceName(target.model),
                                    },
                                    ...(virtual.strategy === 'failover'
                                        ? { priority: target.priority ?? 0 }
                                        : { weight: target.weight ?? 1 }),
                                })),
                            },
                        },
                    },
                },
                { dependsOn: [gateway, ...modelResources], parent: this.parent },
            );
        }
    }

    private parseVirtualModels(providers: ProviderSpec[]): VirtualModelSpec[] {
        const raw = config.getObject(this.appName, 'virtualModels');
        if (raw === undefined) return [];
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            throw new Error(`${this.appName}:virtualModels must be an object.`);
        }

        const availableModels = new Set(
            providers.flatMap(provider =>
                provider.models.map(model => `${provider.clientPrefix}/${model}`),
            ),
        );

        return Object.entries(raw as Record<string, unknown>)
            .map(([name, value]) => {
                if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
                    throw new Error(
                        `${this.appName}:virtualModels has invalid name '${name}'.`,
                    );
                }
                if (typeof value !== 'object' || value === null || Array.isArray(value)) {
                    throw new Error(
                        `${this.appName}:virtualModels.${name} must be an object.`,
                    );
                }
                const { targets } = value as Record<string, unknown>;
                const rawStrategy = (value as Record<string, unknown>).strategy;
                if (
                    rawStrategy !== undefined &&
                    rawStrategy !== 'failover' &&
                    rawStrategy !== 'weighted'
                ) {
                    throw new Error(
                        `${this.appName}:virtualModels.${name}.strategy must be failover or weighted.`,
                    );
                }
                const strategy: VirtualStrategy = rawStrategy ?? 'failover';
                if (!Array.isArray(targets) || targets.length === 0) {
                    throw new Error(
                        `${this.appName}:virtualModels.${name}.targets must be a non-empty list.`,
                    );
                }
                return {
                    name,
                    strategy,
                    targets: targets.map((target, index) => {
                        if (
                            typeof target !== 'object' ||
                            target === null ||
                            Array.isArray(target)
                        ) {
                            throw new Error(
                                `${this.appName}:virtualModels.${name}.targets[${String(index)}] must be an object.`,
                            );
                        }
                        const { model, priority, weight } = target as Record<
                            string,
                            unknown
                        >;
                        if (typeof model !== 'string' || !model) {
                            throw new Error(
                                `${this.appName}:virtualModels.${name}.targets[${String(index)}].model must be a string.`,
                            );
                        }
                        if (!availableModels.has(model)) {
                            throw new Error(
                                `${this.appName}:virtualModels.${name}.targets[${String(index)}].model '${model}' is not a configured provider model.`,
                            );
                        }
                        return {
                            model,
                            ...(priority !== undefined
                                ? { priority: Number(priority) }
                                : {}),
                            ...(weight !== undefined ? { weight: Number(weight) } : {}),
                        };
                    }),
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name));
    }
}
