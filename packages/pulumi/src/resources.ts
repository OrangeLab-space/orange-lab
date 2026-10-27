import { ContainerResources } from './types';

/**
 * Resources for init containers. These only wait for a service, copy a config
 * file or fix volume permissions, so they stay small — but they must not be
 * unbounded, or the pod is BestEffort until they finish.
 */
export const INIT_CONTAINER_RESOURCES: ContainerResources = {
    requests: { cpu: '10m', memory: '32Mi' },
    limits: { cpu: '500m', memory: '64Mi' },
};

/**
 * Resources for the metrics exporter the database operator runs alongside
 * each database.
 */
export const METRICS_EXPORTER_RESOURCES: ContainerResources = {
    requests: { cpu: '10m', memory: '32Mi' },
    limits: { cpu: '500m', memory: '64Mi' },
};

/**
 * Resources for the SQL database containers. The request covers a small
 * database's working set; the limit is deliberately larger because the engine
 * sizes its buffer pool from the limit rather than the request.
 */
export const DATABASE_RESOURCES: ContainerResources = {
    requests: { cpu: '100m', memory: '512Mi' },
    limits: { memory: '1Gi' },
};

/**
 * Resources for the redis container, which holds a much smaller working set
 * than a SQL database.
 */
export const REDIS_RESOURCES: ContainerResources = {
    requests: { cpu: '50m', memory: '64Mi' },
    limits: { memory: '128Mi' },
};

/**
 * Applies an override on top of a default. The override replaces the fields
 * it names in each section and leaves the rest alone, so a caller can raise
 * one value without restating the whole thing.
 */
export function withResources(
    defaults: ContainerResources,
    override?: ContainerResources,
): ContainerResources {
    if (!override) return defaults;
    return {
        requests: { ...defaults.requests, ...override.requests },
        limits: { ...defaults.limits, ...override.limits },
    };
}

/**
 * Parses a resources override read from configuration. Rejects a malformed
 * value here rather than letting it reach the API server as an invalid
 * ResourceRequirements.
 */
export function parseResources(
    value: unknown,
    key: string,
): ContainerResources | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)) {
        throw new Error(`${key} must be an object with requests and limits`);
    }
    const result: ContainerResources = {};
    for (const section of ['requests', 'limits'] as const) {
        const entries = value[section];
        if (entries === undefined) continue;
        if (!isResourceSection(entries)) {
            throw new Error(`${key}.${section} must be an object with cpu and memory`);
        }
        result[section] = entries;
    }
    return result;
}

type ResourceSection = NonNullable<ContainerResources['requests']>;

const RESOURCE_FIELDS: readonly string[] = ['cpu', 'memory'];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isResourceSection(value: unknown): value is ResourceSection {
    return (
        isRecord(value) &&
        Object.entries(value).every(
            ([field, entry]) =>
                RESOURCE_FIELDS.includes(field) && typeof entry === 'string',
        )
    );
}
