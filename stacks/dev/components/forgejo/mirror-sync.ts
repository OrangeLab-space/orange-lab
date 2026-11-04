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

interface MirrorSyncSettings {
    upstreamUrl: string;
    targetUrl: pulumi.Output<string>;
    branches: string[];
    schedule: string;
    image: string;
}

interface MirrorSyncResources {
    credentials: kubernetes.core.v1.Secret;
    script: kubernetes.core.v1.ConfigMap;
}

/**
 * Keeps the Forgejo copy of a repository up to date with an upstream remote.
 *
 * This exists for the repository layout where the upstream (say, a GitHub repo
 * that still accepts public pull requests) owns one branch and Forgejo owns the
 * rest: the upstream branch has to keep moving forward locally without anyone
 * hand-copying commits into the forge. The job is a fast-forward only, so a
 * branch that has moved on both sides is reported and never overwritten.
 */
export function createMirrorSync(
    args: MirrorSyncArgs,
): kubernetes.batch.v1.CronJob | undefined {
    if (!config.getBoolean(args.appName, 'mirrorSync/enabled')) return undefined;

    const metadata = args.metadata.get({ component: 'mirror-sync' });
    const settings = readSettings(args);
    const resources = createResources(args, metadata);

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

    return {
        upstreamUrl: config.require(args.appName, 'mirrorSync/upstreamUrl'),
        targetUrl: pulumi
            .output(args.endpointUrl)
            .apply(url => `${url.replace(/\/+$/, '')}/${repository}.git`),
        branches: config.requireCommaSeparated(args.appName, 'mirrorSync/branches'),
        schedule: config.require(args.appName, 'mirrorSync/schedule'),
        image: config.require(args.appName, 'mirrorSync/image'),
    };
}

/** The push credential, and the upstream one when the remote is not public. */
function createResources(
    args: MirrorSyncArgs,
    metadata: ReturnType<Metadata['get']>,
): MirrorSyncResources {
    const upstreamToken = config.getSecret(args.appName, 'mirrorSync/upstreamToken');

    return {
        credentials: new kubernetes.core.v1.Secret(
            `${args.appName}-mirror-sync`,
            {
                metadata,
                stringData: {
                    TARGET_TOKEN: config.requireSecret(args.appName, 'mirrorSync/token'),
                    ...(upstreamToken ? { UPSTREAM_TOKEN: upstreamToken } : {}),
                },
            },
            { parent: args.parent },
        ),
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

function createPodSpec(
    settings: MirrorSyncSettings,
    resources: MirrorSyncResources,
): kubernetes.types.input.core.v1.PodSpec {
    return {
        restartPolicy: 'Never',
        securityContext: {
            runAsNonRoot: true,
            runAsUser: 65534,
            runAsGroup: 65534,
            seccompProfile: { type: 'RuntimeDefault' },
        },
        containers: [createContainer(settings, resources)],
        volumes: [
            { name: 'script', configMap: { name: resources.script.metadata.name } },
            { name: 'tmp', emptyDir: {} },
        ],
    };
}

function createContainer(
    settings: MirrorSyncSettings,
    resources: MirrorSyncResources,
): kubernetes.types.input.core.v1.Container {
    return {
        name: 'mirror-sync',
        image: settings.image,
        command: ['/bin/sh', '/config/mirror-sync.sh'],
        env: [
            { name: 'HOME', value: '/tmp' },
            { name: 'UPSTREAM_URL', value: settings.upstreamUrl },
            { name: 'TARGET_URL', value: settings.targetUrl },
            { name: 'BRANCHES', value: settings.branches.join(',') },
        ],
        envFrom: [{ secretRef: { name: resources.credentials.metadata.name } }],
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
