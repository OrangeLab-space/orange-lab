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

/** One direction: branches of `targetUrl` are fast-forwarded from `upstreamUrl`. */
interface MirrorDirection {
    name: string;
    /** Config key holding the credential that may push to `targetUrl`. */
    tokenKey: string;
    upstreamUrl: pulumi.Input<string>;
    targetUrl: pulumi.Input<string>;
    branches: string[];
}

interface MirrorSyncSettings {
    upstream: MirrorDirection;
    /** Optional reverse direction: Forgejo's own branches pushed to a remote. */
    push?: MirrorDirection;
    schedule: string;
    image: string;
}

interface MirrorSyncResources {
    credentials: Record<string, kubernetes.core.v1.Secret>;
    script: kubernetes.core.v1.ConfigMap;
}

/**
 * Keeps copies of a repository in step with each other.
 *
 * This exists for the repository layout where the upstream (say, a GitHub repo
 * that still accepts public pull requests) owns one branch and Forgejo owns the
 * rest: the upstream branch has to keep moving forward locally without anyone
 * hand-copying commits into the forge. The reverse direction pushes Forgejo's
 * own branches back out to the upstream, after the forward one has finished.
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
                // One run at a time: two concurrent fetch/push pairs would race
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
        { parent: args.parent },
    );
}

/** The stages of a run, in the order they execute. */
function stages(settings: MirrorSyncSettings): MirrorDirection[] {
    return settings.push ? [settings.upstream, settings.push] : [settings.upstream];
}

function readSettings(args: MirrorSyncArgs): MirrorSyncSettings {
    const repository = config.require(args.appName, 'mirrorSync/repository');
    const localUrl = pulumi
        .output(args.endpointUrl)
        .apply(url => `${url.replace(/\/+$/, '')}/${repository}.git`);
    const pushUrl = config.get(args.appName, 'mirrorSync/pushUrl');

    return {
        upstream: {
            name: 'mirror-sync',
            tokenKey: 'mirrorSync/token',
            upstreamUrl: config.require(args.appName, 'mirrorSync/upstreamUrl'),
            targetUrl: localUrl,
            branches: config.requireCommaSeparated(args.appName, 'mirrorSync/branches'),
        },
        push: pushUrl
            ? {
                  name: 'mirror-push',
                  tokenKey: 'mirrorSync/pushToken',
                  upstreamUrl: localUrl,
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
 * The push credential of every stage, and the script with one settings file per
 * stage beside it - both are mounted, so nothing about a direction is buried in
 * the pod spec.
 */
function createResources(
    args: MirrorSyncArgs,
    settings: MirrorSyncSettings,
    metadata: ReturnType<Metadata['get']>,
): MirrorSyncResources {
    const upstreamToken = config.getSecret(args.appName, 'mirrorSync/upstreamToken');

    const credentials = Object.fromEntries(
        stages(settings).map(direction => [
            direction.name,
            createCredential(
                args,
                metadata,
                direction.name,
                config.requireSecret(args.appName, direction.tokenKey),
                direction === settings.upstream ? upstreamToken : undefined,
            ),
        ]),
    );

    const data: Record<string, pulumi.Input<string>> = {
        'mirror-sync.sh': readFileSync(join(__dirname, 'mirror-sync.sh'), 'utf8'),
    };
    for (const direction of stages(settings)) {
        data[`${direction.name}.env`] =
            pulumi.interpolate`UPSTREAM_URL=${direction.upstreamUrl}
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

function createCredential(
    args: MirrorSyncArgs,
    metadata: ReturnType<Metadata['get']>,
    name: string,
    token: pulumi.Input<string>,
    upstreamToken?: pulumi.Input<string>,
): kubernetes.core.v1.Secret {
    return new kubernetes.core.v1.Secret(
        `${args.appName}-${name}`,
        {
            metadata,
            stringData: {
                TARGET_TOKEN: token,
                ...(upstreamToken ? { UPSTREAM_TOKEN: upstreamToken } : {}),
            },
        },
        { parent: args.parent },
    );
}

function createPodSpec(
    settings: MirrorSyncSettings,
    resources: MirrorSyncResources,
): kubernetes.types.input.core.v1.PodSpec {
    const containers = stages(settings).map(direction =>
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
