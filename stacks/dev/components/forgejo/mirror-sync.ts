import { config, Metadata } from '@orangelab/pulumi';
import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_SCHEDULE = '*/30 * * * *';
const DEFAULT_IMAGE = 'docker.io/alpine/git:2.51.0';

export interface MirrorSyncArgs {
    appName: string;
    /** Public URL of this Forgejo instance, used to address the repository. */
    endpointUrl: pulumi.Input<string>;
    metadata: Metadata;
    parent: pulumi.ComponentResource;
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
    const enabled = config.getBoolean(args.appName, 'mirrorSync/enabled') ?? false;
    if (!enabled) return undefined;

    const upstreamUrl = config.require(args.appName, 'mirrorSync/upstreamUrl');
    const repository = config.require(args.appName, 'mirrorSync/repository');
    const branches = config.requireCommaSeparated(args.appName, 'mirrorSync/branches');
    // Only a private upstream needs a credential; a public one is fetched anonymously.
    const upstreamToken = config.getSecret(args.appName, 'mirrorSync/upstreamToken');
    const schedule = config.get(args.appName, 'mirrorSync/schedule') ?? DEFAULT_SCHEDULE;
    const image = config.get(args.appName, 'mirrorSync/image') ?? DEFAULT_IMAGE;
    const targetUrl = pulumi
        .output(args.endpointUrl)
        .apply(url => `${url.replace(/\/+$/, '')}/${repository}.git`);

    const secret = new kubernetes.core.v1.Secret(
        `${args.appName}-mirror-sync`,
        {
            metadata: args.metadata.get({ component: 'mirror-sync' }),
            stringData: {
                TARGET_TOKEN: config.requireSecret(args.appName, 'mirrorSync/token'),
                ...(upstreamToken ? { UPSTREAM_TOKEN: upstreamToken } : {}),
            },
        },
        { parent: args.parent },
    );

    const script = new kubernetes.core.v1.ConfigMap(
        `${args.appName}-mirror-sync`,
        {
            metadata: args.metadata.get({ component: 'mirror-sync' }),
            data: {
                'mirror-sync.sh': readFileSync(join(__dirname, 'mirror-sync.sh'), 'utf8'),
            },
        },
        { parent: args.parent },
    );

    const metadata = args.metadata.get({ component: 'mirror-sync' });
    return new kubernetes.batch.v1.CronJob(
        `${args.appName}-mirror-sync`,
        {
            metadata,
            spec: {
                schedule,
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
                            spec: {
                                restartPolicy: 'Never',
                                securityContext: {
                                    runAsNonRoot: true,
                                    runAsUser: 65534,
                                    runAsGroup: 65534,
                                    seccompProfile: { type: 'RuntimeDefault' },
                                },
                                containers: [
                                    {
                                        name: 'mirror-sync',
                                        image,
                                        command: ['/bin/sh', '/config/mirror-sync.sh'],
                                        env: [
                                            { name: 'HOME', value: '/tmp' },
                                            { name: 'UPSTREAM_URL', value: upstreamUrl },
                                            { name: 'TARGET_URL', value: targetUrl },
                                            {
                                                name: 'BRANCHES',
                                                value: branches.join(','),
                                            },
                                        ],
                                        envFrom: [
                                            { secretRef: { name: secret.metadata.name } },
                                        ],
                                        volumeMounts: [
                                            {
                                                name: 'script',
                                                mountPath: '/config',
                                                readOnly: true,
                                            },
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
                                    },
                                ],
                                volumes: [
                                    {
                                        name: 'script',
                                        configMap: { name: script.metadata.name },
                                    },
                                    { name: 'tmp', emptyDir: {} },
                                ],
                            },
                        },
                    },
                },
            },
        },
        { parent: args.parent },
    );
}
