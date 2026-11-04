import { config, Metadata } from '@orangelab/pulumi';
import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MirrorSyncArgs {
    appName: string;
    /** Public URL of this Forgejo instance, used to address the repository. */
    endpointUrl: pulumi.Input<string>;
    metadata: Metadata;
    parent: pulumi.ComponentResource;
}

/** One direction: branches of `targetUrl` are fast-forwarded from `sourceUrl`. */
interface MirrorDirection {
    name: 'pull' | 'push';
    /** Config key holding the credential that may push to `targetUrl`. */
    tokenKey: string;
    /** Config key of the source's credential, when the source needs one. */
    sourceTokenKey?: string;
    sourceUrl: pulumi.Input<string>;
    targetUrl: pulumi.Input<string>;
    branches: string[];
}

interface MirrorSyncSettings {
    pull: MirrorDirection;
    /** The reverse direction, present only when a push target is configured. */
    push?: MirrorDirection;
    schedule: string;
    image: string;
}

interface MirrorSyncResources {
    credentials: Record<string, kubernetes.core.v1.Secret>;
    script: kubernetes.core.v1.ConfigMap;
}

/**
 * Keeps two copies of a repository in step with each other.
 *
 * This exists for the repository layout where the upstream (say, a GitHub repo
 * that still accepts public pull requests) owns one branch and Forgejo owns the
 * rest. The `pull` direction fast-forwards the upstream's branches into the
 * local copy; the `push` direction sends Forgejo's own branches back out, after
 * the pull has finished.
 *
 * The local side is named once - `repository`, and the `token` that may write to
 * it - because both directions work on it. A remote is named per direction,
 * `pullUrl`/`pullBranches`/`pullToken` or `pushUrl`/`pushBranches`/`pushToken`,
 * so no key has to be read as "the other direction's".
 *
 * A direction with no URL is not part of the sync at all, and the feature switch
 * sits above every resource: `mirrorSync/enabled: false` creates no CronJob, no
 * ConfigMap and no Secret.
 *
 * Every direction is a fast-forward only, so a branch that has moved on both
 * sides is reported and never overwritten. The push names an explicit refspec
 * and never forces, so it cannot delete or rewind a branch it was not asked to
 * touch - which a forge-side mirror, being a `git push --mirror`, does.
 */
export function createMirrorSync(
    args: MirrorSyncArgs,
): kubernetes.batch.v1.CronJob | undefined {
    if (!config.getBoolean(args.appName, 'mirrorSync/enabled')) return undefined;

    const metadata = args.metadata.get({ component: 'mirror-sync' });
    const settings = readSettings(args);
    const resources = createResources(args, settings, metadata);

    return new kubernetes.batch.v1.CronJob(
        `${args.appName}-mirror-sync`,
        {
            metadata,
            spec: {
                schedule: settings.schedule,
                // One run at a time: two concurrent pull/push pairs would race
                // on the same branches and turn a slow run into a failed one.
                concurrencyPolicy: 'Forbid',
                startingDeadlineSeconds: 300,
                successfulJobsHistoryLimit: 1,
                failedJobsHistoryLimit: 3,
                jobTemplate: {
                    spec: {
                        backoffLimit: 2,
                        activeDeadlineSeconds: 900,
                        template: {
                            metadata: { labels: metadata.labels },
                            spec: createPodSpec(settings, resources),
                        },
                    },
                },
            },
        },
        // The stages reference the Secrets by name, a plain string the provider
        // cannot infer a dependency from: without this the CronJob can be
        // updated before the Secret it mounts exists.
        { parent: args.parent, dependsOn: Object.values(resources.credentials) },
    );
}

/** The directions of a run, in the order they execute. */
function directions(settings: MirrorSyncSettings): MirrorDirection[] {
    return settings.push ? [settings.pull, settings.push] : [settings.pull];
}

function readSettings(args: MirrorSyncArgs): MirrorSyncSettings {
    const repository = config.require(args.appName, 'mirrorSync/repository');
    const localUrl = pulumi
        .output(args.endpointUrl)
        .apply(url => `${url.replace(/\/+$/, '')}/${repository}.git`);
    const pushUrl = config.get(args.appName, 'mirrorSync/pushUrl');

    return {
        pull: {
            name: 'pull',
            tokenKey: 'mirrorSync/token',
            sourceTokenKey: 'mirrorSync/pullToken',
            sourceUrl: config.require(args.appName, 'mirrorSync/pullUrl'),
            targetUrl: localUrl,
            branches: config.requireCommaSeparated(
                args.appName,
                'mirrorSync/pullBranches',
            ),
        },
        // Unset pushUrl is the switch for the direction, not a value to default:
        // without it the job has one stage and the push keys are never read.
        push: pushUrl
            ? {
                  name: 'push',
                  tokenKey: 'mirrorSync/pushToken',
                  sourceUrl: localUrl,
                  targetUrl: pushUrl,
                  branches: config.requireCommaSeparated(
                      args.appName,
                      'mirrorSync/pushBranches',
                  ),
              }
            : undefined,
        schedule: config.require(args.appName, 'mirrorSync/schedule'),
        image: config.require(args.appName, 'mirrorSync/image'),
    };
}

/**
 * The push credential of every direction, and the script with one settings file
 * per direction beside it - both are mounted, so nothing about a direction is
 * buried in the pod spec.
 */
function createResources(
    args: MirrorSyncArgs,
    settings: MirrorSyncSettings,
    metadata: ReturnType<Metadata['get']>,
): MirrorSyncResources {
    const credentials = Object.fromEntries(
        directions(settings).map(direction => [
            direction.name,
            createCredential(args, metadata, direction),
        ]),
    );

    const data: Record<string, pulumi.Input<string>> = {
        'mirror-sync.sh': readFileSync(join(__dirname, 'mirror-sync.sh'), 'utf8'),
    };
    for (const direction of directions(settings)) {
        data[`${direction.name}.env`] =
            pulumi.interpolate`SOURCE_URL=${direction.sourceUrl}
TARGET_URL=${direction.targetUrl}
BRANCHES=${direction.branches.join(',')}
`;
    }

    return {
        credentials,
        script: new kubernetes.core.v1.ConfigMap(
            `${args.appName}-mirror-sync`,
            { metadata, data },
            { parent: args.parent },
        ),
    };
}

/**
 * One Secret per direction, holding only what that direction needs to write to
 * its target - so neither stage is handed the other's credential.
 *
 * The component's `metadata` carries one object name for every resource in it,
 * which is fine for a single object per kind but not for two Secrets: they need
 * their own names, and the name the CronJob refers to them by.
 */
function createCredential(
    args: MirrorSyncArgs,
    metadata: ReturnType<Metadata['get']>,
    direction: MirrorDirection,
): kubernetes.core.v1.Secret {
    const name = `${args.appName}-mirror-${direction.name}`;
    const sourceToken = direction.sourceTokenKey
        ? config.getSecret(args.appName, direction.sourceTokenKey)
        : undefined;

    return new kubernetes.core.v1.Secret(
        name,
        {
            metadata: { ...metadata, name },
            stringData: {
                ...(sourceToken ? { SOURCE_TOKEN: sourceToken } : {}),
                TARGET_TOKEN: config.requireSecret(args.appName, direction.tokenKey),
            },
        },
        { parent: args.parent },
    );
}

function createPodSpec(
    settings: MirrorSyncSettings,
    resources: MirrorSyncResources,
): kubernetes.types.input.core.v1.PodSpec {
    const containers = directions(settings).map(direction =>
        createContainer(direction, resources.credentials[direction.name], settings.image),
    );

    return {
        restartPolicy: 'Never',
        securityContext: {
            runAsNonRoot: true,
            runAsUser: 65534,
            runAsGroup: 65534,
            seccompProfile: { type: 'RuntimeDefault' },
        },
        // Stages run in order: pushing from a copy that failed to update would
        // send the remote the branches it already had, and hide the failure.
        initContainers: containers.slice(0, -1),
        containers: containers.slice(-1),
        volumes: [
            { name: 'script', configMap: { name: resources.script.metadata.name } },
            { name: 'tmp', emptyDir: {} },
        ],
    };
}

function createContainer(
    direction: MirrorDirection,
    credential: kubernetes.core.v1.Secret,
    image: string,
): kubernetes.types.input.core.v1.Container {
    return {
        name: direction.name,
        image,
        command: ['/bin/sh', '/config/mirror-sync.sh', `/config/${direction.name}.env`],
        env: [{ name: 'HOME', value: '/tmp' }],
        envFrom: [{ secretRef: { name: credential.metadata.name } }],
        volumeMounts: [
            { name: 'script', mountPath: '/config', readOnly: true },
            { name: 'tmp', mountPath: '/tmp' },
        ],
        resources: {
            requests: { cpu: '50m', memory: '64Mi' },
            limits: { cpu: '500m', memory: '256Mi' },
        },
        securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
            readOnlyRootFilesystem: true,
        },
    };
}
