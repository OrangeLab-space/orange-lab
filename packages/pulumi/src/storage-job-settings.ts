import * as pulumi from '@pulumi/pulumi';
import { config } from './config';
import { coreStack, resolveInherited } from './core-stack';

export type StorageJobScope = 'app' | 'component';

export type StorageJobSchedule =
    | { scope: StorageJobScope; createJob: false }
    | {
          scope: StorageJobScope;
          createJob: true;
          cron: pulumi.Input<string>;
          retain: pulumi.Input<number>;
          fullInterval?: pulumi.Input<string>;
      };

export interface StorageJobSettings {
    enabled: pulumi.Input<boolean>;
    schedule?: StorageJobSchedule;
}

export interface StorageVolumeJobSettings {
    backup: StorageJobSettings;
    snapshot: StorageJobSettings;
}

interface StorageOverrides {
    enabled?: boolean;
    cron?: string;
    retain?: number;
    fullInterval?: string;
}

/**
 * Backup enablement alone uses the global backup group. Snapshot enablement
 * alone keeps a per-app job because the global snapshot job is optional.
 */
function hasScheduleSettings(
    overrides: StorageOverrides,
    task: 'backup' | 'snapshot',
): boolean {
    if (task === 'snapshot' && overrides.enabled !== undefined) return true;

    return (
        overrides.cron !== undefined ||
        overrides.retain !== undefined ||
        (task === 'backup' && overrides.fullInterval !== undefined)
    );
}

export class StorageJobSettingsResolver {
    private readonly coreLonghorn = coreStack.outputs.config?.apply(
        coreConfig => coreConfig?.longhorn,
    );

    constructor(private readonly appName: string) {}

    getVolumeSettings(volumeName?: string): StorageVolumeJobSettings {
        return {
            backup: this.getJobSettings('backup', volumeName),
            snapshot: this.getJobSettings('snapshot', volumeName),
        };
    }

    private getJobSettings(
        task: 'backup' | 'snapshot',
        volumeName?: string,
    ): StorageJobSettings {
        const { component, app, scope } = this.resolveScope(volumeName, task);
        const enabledOverride = component?.enabled ?? app.enabled;

        return {
            enabled:
                enabledOverride ??
                this.resolveEnabled(task, scope !== undefined),
            schedule: scope
                ? this.createSchedule(
                      task,
                      scope,
                      component,
                      app,
                      enabledOverride,
                  )
                : undefined,
        };
    }

    private resolveScope(
        volumeName: string | undefined,
        task: 'backup' | 'snapshot',
    ): {
        component?: StorageOverrides;
        app: StorageOverrides;
        scope?: StorageJobScope;
    } {
        const component = volumeName
            ? this.getOverrides(volumeName, task)
            : undefined;
        const app = this.getOverrides(undefined, task);
        const scope = component && hasScheduleSettings(component, task)
            ? 'component'
            : hasScheduleSettings(app, task)
              ? 'app'
              : undefined;

        return { component, app, scope };
    }

    private resolveEnabled(
        task: 'backup' | 'snapshot',
        customSchedule: boolean,
    ): pulumi.Input<boolean> {
        if (task === 'backup') {
            return this.resolveBackupEnabled(customSchedule);
        }

        return customSchedule
            ? this.getLonghornGlobalBoolean('snapshotEnabled')
            : false;
    }

    private createSchedule(
        task: 'backup' | 'snapshot',
        scope: StorageJobScope,
        component: StorageOverrides | undefined,
        app: StorageOverrides,
        enabledOverride: boolean | undefined,
    ): StorageJobSchedule {
        if (enabledOverride === false) return { scope, createJob: false };

        const schedule = {
            scope,
            createJob: true as const,
            cron:
                component?.cron ??
                app.cron ??
                this.getLonghornString(`${task}Cron`),
            retain:
                component?.retain ??
                app.retain ??
                this.getLonghornNumber(`${task}Retain`),
        };
        if (task !== 'backup') return schedule;

        return {
            ...schedule,
            fullInterval:
                component?.fullInterval ??
                app.fullInterval ??
                this.getLonghornString('backupFullInterval'),
        };
    }

    private resolveBackupEnabled(
        customSchedule: boolean,
    ): pulumi.Input<boolean> {
        const participates = this.resolveBackupParticipation();
        if (!customSchedule) return participates;

        return pulumi
            .all([participates, this.getLonghornGlobalBoolean('backupEnabled')])
            .apply(
                ([participates, globalEnabled]) =>
                    participates && globalEnabled,
            );
    }

    private getOverrides(
        volumeName: string | undefined,
        task: 'backup' | 'snapshot',
    ): StorageOverrides {
        const prefix = volumeName ? `${volumeName}/` : '';

        return {
            enabled: config.getBoolean(
                this.appName,
                `${prefix}storage/${task}Enabled`,
            ),
            cron: config.get(this.appName, `${prefix}storage/${task}Cron`),
            retain: config.getNumber(
                this.appName,
                `${prefix}storage/${task}Retain`,
            ),
            fullInterval:
                task === 'backup'
                    ? config.get(
                          this.appName,
                          `${prefix}storage/backupFullInterval`,
                      )
                    : undefined,
        };
    }

    private resolveBackupParticipation(): pulumi.Input<boolean> {
        const localBackupValue = config.getBoolean('longhorn', 'backupAllVolumes');
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
