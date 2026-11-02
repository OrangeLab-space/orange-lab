import { config } from '@orangelab/pulumi';
import { parse as parseYaml } from 'yaml';

export type ModelEngine = 'OLlama' | 'LlamaCpp' | 'VLLM';
export type ModelEngineKey = 'llamacpp' | 'ollama' | 'vllm';
export type ModelGpu = 'amd' | 'nvidia';

export type ModelImages = Partial<
    Record<ModelEngineKey, Partial<Record<ModelGpu, string>>>
>;

export interface ModelDefinition {
    args?: string[];
    engine: ModelEngine;
    image?: string;
    /**
     * Replicas kept running when idle. Set 0 to scale to zero and release the
     * GPU; the first request then waits for the model to load again.
     */
    minReplicas?: number;
    name: string;
    node: string;
    source?: string;
    url?: string;
}

export interface ModelNodeSpec {
    env: Record<string, string>;
    gpu: ModelGpu;
    name: string;
    storageSize: string;
}

type ModelDefinitionFields = Pick<
    ModelDefinition,
    'args' | 'image' | 'minReplicas' | 'source' | 'url'
>;

const engines: readonly ModelEngine[] = ['OLlama', 'LlamaCpp', 'VLLM'];
const engineKeys: readonly ModelEngineKey[] = ['ollama', 'llamacpp', 'vllm'];
const gpus: readonly ModelGpu[] = ['amd', 'nvidia'];

export const modelEngineKeys = engineKeys;
export const modelEngineNames: Record<ModelEngineKey, ModelEngine> = {
    llamacpp: 'LlamaCpp',
    ollama: 'OLlama',
    vllm: 'VLLM',
};

const dnsSubdomain = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

export function parseModelNodes(appName: string): Map<string, ModelNodeSpec> {
    const raw = config.getObject(appName, 'modelNodes');
    if (raw === undefined) return new Map();
    if (!isRecord(raw)) {
        fail(`${appName}:modelNodes`, 'must be a map of node name to settings.');
    }

    return new Map(
        Object.entries(raw).map(([name, value]) => parseModelNode(appName, name, value)),
    );
}

function parseModelNode(
    appName: string,
    name: string,
    value: unknown,
): [string, ModelNodeSpec] {
    const path = `${appName}:modelNodes.${name}`;
    if (!dnsSubdomain.test(name)) {
        fail(`${appName}:modelNodes`, `has invalid node name '${name}'.`);
    }
    if (!isRecord(value)) fail(path, 'must be an object.');
    const { env, gpu, storageSize } = value;
    if (typeof storageSize !== 'string' || !storageSize) {
        fail(`${path}.storageSize`, 'must be a non-empty string.');
    }
    return [
        name,
        {
            env: parseEnv(env, `${path}.env`),
            gpu: parseGpu(gpu, `${path}.gpu`),
            name,
            storageSize,
        },
    ];
}

export function parseModelImages(appName: string): ModelImages {
    const raw = getImagesConfig(appName);
    if (raw === undefined) return {};
    if (!isRecord(raw)) {
        fail(`${appName}:images`, 'must be a map of engine to GPU images.');
    }

    const images: ModelImages = {};
    for (const [engine, value] of Object.entries(raw)) {
        if (!isModelEngineKey(engine)) {
            fail(`${appName}:images`, `has invalid engine '${engine}'.`);
        }
        if (!isRecord(value)) {
            fail(`${appName}:images.${engine}`, 'must be an object.');
        }
        const byGpu: Partial<Record<ModelGpu, string>> = {};
        for (const [gpu, image] of Object.entries(value)) {
            if (gpu !== 'amd' && gpu !== 'nvidia') {
                fail(
                    `${appName}:images.${engine}.${gpu}`,
                    `must be one of: ${gpus.join(', ')}.`,
                );
            }
            if (typeof image !== 'string' || !image) {
                fail(`${appName}:images.${engine}.${gpu}`, 'must be a non-empty string.');
            }
            byGpu[gpu] = image;
        }
        images[engine] = byGpu;
    }
    return images;
}

export function parseModelDefinitions(
    appName: string,
    nodes: Map<string, ModelNodeSpec>,
): ModelDefinition[] {
    const raw = config.getObject(appName, 'modelDefinitions');
    if (raw === undefined) return [];
    if (!isRecord(raw)) {
        fail(`${appName}:modelDefinitions`, 'must be a map of model name to settings.');
    }

    return Object.entries(raw).map(([name, value]) => {
        const path = `${appName}:modelDefinitions.${name}`;
        if (!dnsSubdomain.test(name)) {
            fail(`${appName}:modelDefinitions`, `has invalid model name '${name}'.`);
        }
        if (!isRecord(value)) fail(path, 'must be an object.');
        return parseModelDefinition(appName, name, value, nodes);
    });
}

function parseModelDefinition(
    appName: string,
    name: string,
    value: Record<string, unknown>,
    nodes: Map<string, ModelNodeSpec>,
): ModelDefinition {
    const path = `${appName}:modelDefinitions.${name}`;
    const engine = parseEngine(value.engine, `${path}.engine`);
    const node = parseNode(value.node, nodes, `${path}.node`);
    const fields = parseDefinitionFields(value, path);
    validateModelSource(engine, fields, path);
    return { name, node, engine, ...fields };
}

function parseNode(
    value: unknown,
    nodes: Map<string, ModelNodeSpec>,
    path: string,
): string {
    if (typeof value === 'string' && nodes.has(value)) return value;
    fail(
        path,
        nodes.size
            ? `must be one of: ${[...nodes.keys()].join(', ')}.`
            : 'requires kubeai:modelNodes to define at least one node.',
    );
}

function parseDefinitionFields(
    value: Record<string, unknown>,
    path: string,
): ModelDefinitionFields {
    const { image, minReplicas, source, url } = value;
    if (source !== undefined && typeof source !== 'string') {
        fail(`${path}.source`, 'must be a string.');
    }
    if (url !== undefined && typeof url !== 'string') {
        fail(`${path}.url`, 'must be a string.');
    }
    if (image !== undefined && typeof image !== 'string') {
        fail(`${path}.image`, 'must be a string.');
    }
    if (minReplicas !== undefined && minReplicas !== 0 && minReplicas !== 1) {
        fail(`${path}.minReplicas`, 'must be 0 or 1.');
    }
    const args = parseArgs(value.args, path);
    return {
        ...(typeof source === 'string' ? { source } : {}),
        ...(typeof url === 'string' ? { url } : {}),
        ...(typeof image === 'string' ? { image } : {}),
        ...(typeof minReplicas === 'number' ? { minReplicas } : {}),
        ...(args ? { args } : {}),
    };
}

function parseArgs(value: unknown, path: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (
        !Array.isArray(value) ||
        value.some(arg => typeof arg !== 'string' && typeof arg !== 'number')
    ) {
        fail(`${path}.args`, 'must be a list of strings or numbers.');
    }
    return value.map(String);
}

function validateModelSource(
    engine: ModelEngine,
    fields: ModelDefinitionFields,
    path: string,
): void {
    if (engine === 'OLlama' && !fields.source) {
        fail(`${path}.source`, 'must be a non-empty string for OLlama.');
    }
    if (engine !== 'OLlama' && !fields.url) {
        fail(`${path}.url`, `is required for ${engine}.`);
    }
}

export function nodeResourceProfile(node: ModelNodeSpec): string {
    return `${node.gpu}-${node.name}`;
}

function parseEngine(value: unknown, key: string): ModelEngine {
    const engine = value ?? 'OLlama';
    if (typeof engine !== 'string' || !isModelEngine(engine)) {
        fail(key, `must be one of: ${engines.join(', ')}.`);
    }
    return engine;
}

function getImagesConfig(appName: string): unknown {
    try {
        return config.getObject(appName, 'images');
    } catch {
        const value = config.get(appName, 'images');
        if (value === undefined) return undefined;
        return parseYaml(value);
    }
}

function isModelEngine(value: string): value is ModelEngine {
    return (engines as readonly string[]).includes(value);
}

function isModelEngineKey(value: string): value is ModelEngineKey {
    return (engineKeys as readonly string[]).includes(value);
}

function parseGpu(value: unknown, key: string): ModelGpu {
    if (typeof value !== 'string' || !isModelGpu(value)) {
        fail(key, `must be one of: ${gpus.join(', ')}.`);
    }
    return value;
}

function isModelGpu(value: string): value is ModelGpu {
    return (gpus as readonly string[]).includes(value);
}

function parseEnv(value: unknown, key: string): Record<string, string> {
    if (value === undefined) return {};
    if (!isRecord(value)) fail(key, 'must be a map.');
    return Object.fromEntries(
        Object.entries(value).map(([name, entry]) => {
            if (typeof entry !== 'string' && typeof entry !== 'number') {
                fail(`${key}.${name}`, 'must be a string.');
            }
            return [name, String(entry)];
        }),
    );
}

function fail(key: string, message: string): never {
    throw new Error(`${key}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
