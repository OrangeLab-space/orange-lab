import * as pulumi from '@pulumi/pulumi';
import * as crypto from 'crypto';
import assert from 'node:assert';
import { LonghornRecurringJob } from './longhorn-recurring-job';
import type { LonghornVolumeRecurringJobsArgs } from './longhorn-volume';
import { StorageJobSettingsResolver } from './storage-job-settings';
import type {
    StorageJobSchedule,
    StorageJobScope,
} from './storage-job-settings';

export class StorageRecurringJobs {
    private readonly jobs = new Map<string, LonghornRecurringJob>();
    private readonly resolver: StorageJobSettingsResolver;

    constructor(
        private readonly appName: string,
        private readonly parent: pulumi.ComponentResource,
    ) {
        this.resolver = new StorageJobSettingsResolver(appName);
    }

    getVolumeArgs(volumeName?: string): LonghornVolumeRecurringJobsArgs {
        const settings = this.resolver.getVolumeSettings(volumeName);

        return {
            backup: {
                customSchedule: settings.backup.schedule !== undefined,
                enabled: settings.backup.enabled,
                jobName: this.createBackupJob(
                    settings.backup.schedule,
                    volumeName,
                ),
            },
            snapshot: {
                customSchedule: settings.snapshot.schedule !== undefined,
                enabled: settings.snapshot.enabled,
                jobName: this.createSnapshotJob(
                    settings.snapshot.schedule,
                    volumeName,
                ),
            },
        };
    }

    private createBackupJob(
        schedule: StorageJobSchedule | undefined,
        volumeName?: string,
    ): string | undefined {
        if (!schedule?.createJob) return undefined;
        assert(
            schedule.fullInterval !== undefined,
            'Backup job requires a full-backup interval',
        );

        const jobName = this.getRecurringJobName(
            'backup',
            schedule.scope,
            volumeName,
        );
        if (!this.jobs.has(jobName)) {
            this.jobs.set(
                jobName,
                new LonghornRecurringJob(
                    jobName,
                    {
                        name: jobName,
                        task: 'backup',
                        cron: schedule.cron,
                        retain: schedule.retain,
                        parameters: {
                            'full-backup-interval': schedule.fullInterval,
                        },
                    },
                    { parent: this.parent },
                ),
            );
        }
        return jobName;
    }

    private createSnapshotJob(
        schedule: StorageJobSchedule | undefined,
        volumeName?: string,
    ): string | undefined {
        if (!schedule?.createJob) return undefined;

        const jobName = this.getRecurringJobName(
            'snapshot',
            schedule.scope,
            volumeName,
        );
        if (!this.jobs.has(jobName)) {
            this.jobs.set(
                jobName,
                new LonghornRecurringJob(
                    jobName,
                    {
                        name: jobName,
                        task: 'snapshot',
                        cron: schedule.cron,
                        retain: schedule.retain,
                    },
                    { parent: this.parent },
                ),
            );
        }
        return jobName;
    }

    private getRecurringJobName(
        task: 'snapshot' | 'backup',
        scope: StorageJobScope,
        volumeName?: string,
    ): string {
        const componentName = volumeName ?? '';
        if (scope === 'component') {
            assert(componentName, 'Component job requires a volume name');
        }
        const target =
            scope === 'component'
                ? `${this.appName}-${componentName}`
                : this.appName;
        const name = `${target}-${task}`;
        if (name.length <= 40) return name;

        const hash = crypto.createHash('sha1').update(name).digest('hex').slice(0, 8);
        return `${name.slice(0, 31)}-${hash}`;
    }
}
