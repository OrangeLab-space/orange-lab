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
