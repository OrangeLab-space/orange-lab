import { config } from '@orangelab/pulumi';
import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { createHash } from 'node:crypto';

const rateKeys = new Set([
    'cacheRead',
    'cacheWrite',
    'input',
    'inputAudio',
    'output',
    'outputAudio',
    'perAudioMinute',
    'perPage',
    'reasoning',
]);

export interface ModelCatalog {
    sources: {
        configMap: {
            key: string;
            name: pulumi.Input<string>;
        };
    }[];
}

export class ModelCostCatalog {
    public readonly configMap?: kubernetes.core.v1.ConfigMap;

    constructor(
        private readonly appName: string,
        private readonly namespace: pulumi.Input<string>,
        private readonly parent: pulumi.Resource,
    ) {
        const modelCosts = config.getObject(appName, 'modelCosts');
        if (modelCosts === undefined) return;
        if (!isRecord(modelCosts)) {
            throw new Error(`${appName}:modelCosts must be a map.`);
        }
        if ('metadata' in modelCosts) {
            throw new Error(
                `${appName}:modelCosts must not set metadata; it is applied as an overlay.`,
            );
        }

        const catalog = JSON.stringify(normalizeModelCosts(modelCosts));
        const name = `${appName}-model-costs-${createHash('sha256')
            .update(catalog)
            .digest('hex')
            .slice(0, 8)}`;
        this.configMap = new kubernetes.core.v1.ConfigMap(
            name,
            {
                data: { 'catalog.json': catalog },
                metadata: { name, namespace },
            },
            { parent },
        );
    }

    get modelCatalog(): ModelCatalog | undefined {
        if (!this.configMap) return undefined;
        return {
            sources: [
                {
                    configMap: {
                        key: 'catalog.json',
                        name: this.configMap.metadata.name,
                    },
                },
            ],
        };
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeModelCosts(value: unknown, inRates = false): unknown {
    if (Array.isArray(value)) {
        return value.map(item => normalizeModelCosts(item, inRates));
    }
    if (!isRecord(value)) return value;

    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        if (inRates && rateKeys.has(key) && typeof child === 'number') {
            result[key] = String(child);
        } else if (key === 'cacheWriteDetails' && isRecord(child)) {
            result[key] = Object.fromEntries(
                Object.entries(child).map(([ttl, rate]) => [
                    ttl,
                    typeof rate === 'number' ? String(rate) : rate,
                ]),
            );
        } else {
            result[key] = normalizeModelCosts(child, inRates || key === 'rates');
        }
    }
    return result;
}
