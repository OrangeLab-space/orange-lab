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
    upstreamUrl: pulumi.Input<string>;
    targetUrl: pulumi.Input<string>;
    branches: string[];
}

interface MirrorSyncSettings {
    upstream: MirrorDirection;
    /** Optional reverse direction: Forgejo's own branches pushed to a remote. */
    sink?: MirrorDirection;
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
 * hand-copying commits into the forge. The reverse direction, the sink, pushes
 * Forgejo's own branches back out to the upstream.
 *
 * Every direction is a fast-forward only, so a branch that has moved on both
 * sides is reported and never overwritten. The sink names an explicit refspec
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

function readSettings(args: MirrorSyncArgs): MirrorSyncSettings {
    const repository = config.require(args.appName, 'mirrorSync/repository');
    const localUrl = pulumi
        .output(args.endpointUrl)
        .apply(url => `${url.replace(/\/+$/, '')}/${repository}.git`);
    const sinkUrl = config.get(args.appName, 'mirrorSync/sinkUrl');

    return {
        upstream: {
            name: 'mirror-sync',
            upstreamUrl: config.require(args.appName, 'mirrorSync/upstreamUrl'),
            targetUrl: localUrl,
            branches: config.requireCommaSeparated(args.appName, 'mirrorSync/branches'),
        },
        sink: sinkUrl
            ? {
                  name: 'mirror-sink',
                  upstreamUrl: localUrl,
                  targetUrl: sinkUrl,
                  branches: config.requireCommaSeparated(
                      args.appName,
                      'mirrorSync/sinkBranches',
                  ),
              }
            : undefined,
        schedule: config.require(args.appName, 'mirrorSync/schedule'),
        image: config.require(args.appName, 'mirrorSync/image'),
    };
}

/** One credential per direction, holding the push token and any pulls it needs. */
function createResources(
    args: MirrorSyncArgs,
    settings: MirrorSyncSettings,
    metadata: ReturnType<Metadata['get']>,
): MirrorSyncResources {
    const upstreamToken = config.getSecret(args.appName, 'mirrorSync/upstreamToken');

    return {
        credentials: {
            [settings.upstream.name]: createCredential(
                args,
                metadata,
                settings.upstream.name,
                config.requireSecret(args.appName, 'mirrorSync/token'),
                upstreamToken,
            ),
            ...(settings.sink
                ? {
                      [settings.sink.name]: createCredential(
                          args,
                          metadata,
                          settings.sink.name,
                          config.requireSecret(args.appName, 'mirrorSync/sinkToken'),
                      ),
                  }
                : {}),
        },
        script: new kubernetes.core.v1.ConfigMap(
            `${args.appName}-mirror-sync`,
            {
                metadata,
                data: {
                    'mirror-sync.sh': readFileSync(
                        join(__dirname, 'mirror-sync.sh'),
                        'utf8',
                    ),
                },
            },
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
    const directions = settings.sink
        ? [settings.upstream, settings.sink]
        : [settings.upstream];

    return {
        restartPolicy: 'Never',
        securityContext: {
            runAsNonRoot: true,
            runAsUser: 65534,
            runAsGroup: 65534,
            seccompProfile: { type: 'RuntimeDefault' },
        },
        containers: directions.map(direction =>
            createContainer(
                direction,
                resources.credentials[direction.name],
                settings.image,
            ),
        ),
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
        command: ['/bin/sh', '/config/mirror-sync.sh'],
        env: [
            { name: 'HOME', value: '/tmp' },
            { name: 'UPSTREAM_URL', value: direction.upstreamUrl },
            { name: 'TARGET_URL', value: direction.targetUrl },
            { name: 'BRANCHES', value: direction.branches.join(',') },
        ],
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
