import { Application, config, S3Provisioner } from '@orangelab/pulumi';
import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

type S3Credentials = ReturnType<S3Provisioner['create']>;

export interface LonghornBackupStore {
    backupTarget: string;
    backupTargetCredentialSecret: pulumi.Input<string>;
}

export interface LonghornJobsArgs {
    name: string;
    app: Application;
    parent: pulumi.ComponentResource;
    s3Provisioner?: S3Provisioner;
}

interface RecurringJobSpec {
    name: string;
    task: string;
    groups: string[];
    retain: number;
    parameters?: Record<string, pulumi.Input<string>>;
}

export class LonghornJobs {
    /** Helm values for Longhorn's default backup store; empty when backups are off. */
    public readonly defaultBackupStore: LonghornBackupStore;

    private readonly backupEnabled: boolean;

    constructor(private readonly args: LonghornJobsArgs) {
        this.backupEnabled = config.requireBoolean(args.name, 'backupEnabled');
        this.defaultBackupStore =
            this.backupEnabled && args.s3Provisioner
                ? this.createBackupStore(args.s3Provisioner)
                : { backupTarget: '', backupTargetCredentialSecret: '' };
    }

    public createRecurringJobs(chart: pulumi.Resource) {
        const name = this.args.name;
        if (config.requireBoolean(name, 'snapshotEnabled')) {
            this.createRecurringJob(chart, {
                name: 'snapshot',
                task: 'snapshot',
                groups: ['default'],
                retain: config.requireNumber(name, 'snapshotRetain'),
            });
        }
        if (config.requireBoolean(name, 'trimEnabled')) {
            this.createRecurringJob(chart, {
                name: 'trim',
                task: 'filesystem-trim',
                groups: ['default'],
                retain: 0,
            });
        }
        if (this.backupEnabled) {
            this.createRecurringJob(chart, {
                name: 'backup',
                task: 'backup',
                groups: ['backup'],
                retain: config.requireNumber(name, 'backupRetain'),
                parameters: {
                    'full-backup-interval': config.require(name, 'backupFullInterval'),
                },
            });
        }
    }

    private createRecurringJob(chart: pulumi.Resource, job: RecurringJobSpec) {
        const cron = config.require(this.args.name, `${job.name}Cron`);
        new kubernetes.apiextensions.CustomResource(
            `${this.args.name}-${job.name}-job`,
            {
                apiVersion: 'longhorn.io/v1beta2',
                kind: 'RecurringJob',
                metadata: {
                    name: job.name,
                    namespace: this.args.app.metadata.namespace,
                },
                spec: {
                    ...job,
                    concurrency: 2,
                    cron,
                    labels: { cron },
                },
            },
            { dependsOn: chart, parent: this.args.parent },
        );
    }

    private createBackupStore(s3Provisioner: S3Provisioner): LonghornBackupStore {
        const { backupTarget, bucket } = this.getBackupTarget();
        const secretName = `${this.args.name}-${s3Provisioner.instanceName}-backup`;
        this.createBackupSecret(
            secretName,
            s3Provisioner.create({ username: this.args.name, bucket }),
        );

        return { backupTarget, backupTargetCredentialSecret: secretName };
    }

    private getBackupTarget() {
        // Longhorn's URL is s3://<bucket>@<region>/[<path>/]; the bucket is
        // also what the provisioner creates and grants the user access to.
        const backupTarget = config.require(this.args.name, 'backupTarget');
        const bucketMatch = /^s3:\/\/([^@/]+)@/.exec(backupTarget);
        if (!bucketMatch) {
            throw new Error(
                `Longhorn: invalid longhorn:backupTarget '${backupTarget}'. Expected s3://<bucket>@<region>/[<path>/].`,
            );
        }

        return { backupTarget, bucket: bucketMatch[1] };
    }

    private createBackupSecret(secretName: string, credentials: S3Credentials) {
        // `data` rather than `stringData`: stringData is write-only (merged into
        // `data` on write, never returned on read), so the provider cannot
        // verify it and a credential change would need a replacement.
        const data = pulumi
            .all([
                credentials.accessKey,
                credentials.secretKey,
                credentials.s3EndpointUrl,
            ])
            .apply(([accessKey, secretKey, endpoint]) => ({
                AWS_ACCESS_KEY_ID: Buffer.from(accessKey).toString('base64'),
                AWS_SECRET_ACCESS_KEY: Buffer.from(secretKey).toString('base64'),
                AWS_ENDPOINTS: Buffer.from(endpoint).toString('base64'),
                VIRTUAL_HOSTED_STYLE: Buffer.from('false').toString('base64'),
            }));

        new kubernetes.core.v1.Secret(
            `${secretName}-secret`,
            {
                metadata: {
                    name: secretName,
                    namespace: this.args.app.metadata.namespace,
                },
                data,
            },
            { parent: this.args.parent, deleteBeforeReplace: true },
        );
    }
}
