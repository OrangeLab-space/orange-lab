import { config } from '@orangelab/pulumi';

export type ModelEngine = 'OLlama' | 'LlamaCpp' | 'VLLM';

export interface ModelDefinition {
    args?: string[];
    engine: ModelEngine;
    image?: string;
    name: string;
    node: string;
    source?: string;
    url?: string;
}

export interface ModelNodeSpec {
    env: Record<string, string>;
    name: string;
    storageSize: string;
}

type ModelDefinitionFields = Pick<ModelDefinition, 'args' | 'image' | 'source' | 'url'>;

const engines: readonly ModelEngine[] = ['OLlama', 'LlamaCpp', 'VLLM'];
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
    const { env, storageSize } = value;
    if (typeof storageSize !== 'string' || !storageSize) {
        fail(`${path}.storageSize`, 'must be a non-empty string.');
    }
    return [name, { env: parseEnv(env, `${path}.env`), name, storageSize }];
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
    const { image, source, url } = value;
    if (source !== undefined && typeof source !== 'string') {
        fail(`${path}.source`, 'must be a string.');
    }
    if (url !== undefined && typeof url !== 'string') {
        fail(`${path}.url`, 'must be a string.');
    }
    if (image !== undefined && typeof image !== 'string') {
        fail(`${path}.image`, 'must be a string.');
    }
    const args = parseArgs(value.args, path);
    return {
        ...(typeof source === 'string' ? { source } : {}),
        ...(typeof url === 'string' ? { url } : {}),
        ...(typeof image === 'string' ? { image } : {}),
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

export function nodeResourceProfile(node: string): string {
    return `amd-${node}`;
}

function parseEngine(value: unknown, key: string): ModelEngine {
    const engine = value ?? 'OLlama';
    if (typeof engine !== 'string' || !isModelEngine(engine)) {
        fail(key, `must be one of: ${engines.join(', ')}.`);
    }
    return engine;
}

function isModelEngine(value: string): value is ModelEngine {
    return (engines as readonly string[]).includes(value);
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
