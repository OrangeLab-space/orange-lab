import * as pulumi from '@pulumi/pulumi';
import * as crypto from 'crypto';
import { config } from './config';
import { coreStack, resolveInherited } from './core-stack';
import { LonghornRecurringJob } from './longhorn-recurring-job';
import type { LonghornVolumeRecurringJobsArgs } from './longhorn-volume';

export class StorageRecurringJobs {
    private readonly jobs = new Map<string, LonghornRecurringJob>();
    private readonly coreLonghorn = coreStack.outputs.config?.apply(
        coreConfig => coreConfig?.longhorn,
    );

    constructor(
        private readonly appName: string,
        private readonly parent: pulumi.ComponentResource,
    ) {}

    getVolumeArgs(volumeName?: string): LonghornVolumeRecurringJobsArgs {
        const snapshot = this.getSnapshotRecurringJob();
        const backup = this.getBackupRecurringJob();

        return {
            backup: {
                customSchedule: backup.customSchedule,
                enabled: this.getBackupEnabled(backup.customSchedule, volumeName),
                jobName: backup.jobName,
            },
            snapshot: {
                customSchedule: snapshot.customSchedule,
                enabled: snapshot.enabled,
                jobName: snapshot.jobName,
            },
        };
    }

    private getBackupEnabled(
        customSchedule: boolean,
        volumeName?: string,
    ): pulumi.Input<boolean> {
        const appEnabled = config.getBoolean(this.appName, 'storage/backupEnabled');
        if (appEnabled !== undefined) return appEnabled;

        const participates = this.resolveBackupParticipation(volumeName);
        if (!customSchedule) return participates;

        return pulumi
            .all([participates, this.getLonghornGlobalBoolean('backupEnabled')])
            .apply(
                ([participates, globalEnabled]) =>
                    participates && globalEnabled,
            );
    }

    private getSnapshotRecurringJob(): {
        customSchedule: boolean;
        enabled: pulumi.Input<boolean>;
        jobName?: string;
    } {
        const enabledOverride = config.getBoolean(
            this.appName,
            'storage/snapshotEnabled',
        );
        const cronOverride = config.get(this.appName, 'storage/snapshotCron');
        const retainOverride = config.getNumber(
            this.appName,
            'storage/snapshotRetain',
        );
        const customSchedule =
            enabledOverride !== undefined ||
            cronOverride !== undefined ||
            retainOverride !== undefined;
        if (!customSchedule) return { customSchedule: false, enabled: false };

        const enabled =
            enabledOverride ?? this.getLonghornGlobalBoolean('snapshotEnabled');
        if (enabledOverride === false) return { customSchedule: true, enabled };

        const jobName = this.getRecurringJobName('snapshot');
        if (!this.jobs.has(jobName)) {
            this.jobs.set(
                jobName,
                new LonghornRecurringJob(
                    jobName,
                    {
                        name: jobName,
                        task: 'snapshot',
                        cron:
                            cronOverride ?? this.getLonghornString('snapshotCron'),
                        retain:
                            retainOverride ??
                            this.getLonghornNumber('snapshotRetain'),
                    },
                    { parent: this.parent },
                ),
            );
        }

        return { customSchedule: true, enabled, jobName };
    }

    private getBackupRecurringJob(): {
        customSchedule: boolean;
        jobName?: string;
    } {
        const enabledOverride = config.getBoolean(
            this.appName,
            'storage/backupEnabled',
        );
        const cronOverride = config.get(this.appName, 'storage/backupCron');
        const retainOverride = config.getNumber(
            this.appName,
            'storage/backupRetain',
        );
        const fullIntervalOverride = config.get(
            this.appName,
            'storage/backupFullInterval',
        );
        const customSchedule =
            enabledOverride !== undefined ||
            cronOverride !== undefined ||
            retainOverride !== undefined ||
            fullIntervalOverride !== undefined;
        if (!customSchedule) return { customSchedule: false };
        if (enabledOverride === false) return { customSchedule: true };

        const jobName = this.getRecurringJobName('backup');
        if (!this.jobs.has(jobName)) {
            this.jobs.set(
                jobName,
                new LonghornRecurringJob(
                    jobName,
                    {
                        name: jobName,
                        task: 'backup',
                        cron: cronOverride ?? this.getLonghornString('backupCron'),
                        retain:
                            retainOverride ??
                            this.getLonghornNumber('backupRetain'),
                        parameters: {
                            'full-backup-interval':
                                fullIntervalOverride ??
                                this.getLonghornString('backupFullInterval'),
                        },
                    },
                    { parent: this.parent },
                ),
            );
        }

        return { customSchedule: true, jobName };
    }

    private getRecurringJobName(task: 'snapshot' | 'backup'): string {
        const name = `${this.appName}-${task}`;
        if (name.length <= 40) return name;

        const hash = crypto.createHash('sha1').update(name).digest('hex').slice(0, 8);
        return `${name.slice(0, 31)}-${hash}`;
    }

    private resolveBackupParticipation(volumeName?: string): pulumi.Input<boolean> {
        const prefix = volumeName ? `${volumeName}/` : '';
        const localBackupValue =
            config.getBoolean(this.appName, `${prefix}backupVolume`) ??
            config.getBoolean('longhorn', 'backupAllVolumes');
        if (localBackupValue !== undefined) return localBackupValue;

        return resolveInherited({
            settingName: 'longhorn.backupAllVolumes',
            coreValue: coreStack.outputs.config?.apply(
                coreConfig => coreConfig?.longhorn?.backupAllVolumes,
            ),
        });
    }

    private getLonghornGlobalBoolean(
        key: 'backupEnabled' | 'snapshotEnabled',
    ): pulumi.Input<boolean> {
        return (
            config.getBoolean('longhorn', key) ??
            resolveInherited({
                settingName: `longhorn.${key}`,
                coreValue: this.coreLonghorn?.apply(coreConfig => coreConfig?.[key]),
            })
        );
    }

    private getLonghornString(
        key: 'backupCron' | 'backupFullInterval' | 'snapshotCron',
    ): pulumi.Input<string> {
        return (
            config.get('longhorn', key) ??
            resolveInherited({
                settingName: `longhorn.${key}`,
                coreValue: this.coreLonghorn?.apply(coreConfig => coreConfig?.[key]),
            })
        );
    }

    private getLonghornNumber(
        key: 'backupRetain' | 'snapshotRetain',
    ): pulumi.Input<number> {
        return (
            config.getNumber('longhorn', key) ??
            resolveInherited({
                settingName: `longhorn.${key}`,
                coreValue: this.coreLonghorn?.apply(coreConfig => coreConfig?.[key]),
            })
        );
    }
}
