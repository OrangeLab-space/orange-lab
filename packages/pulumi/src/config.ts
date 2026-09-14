/* eslint-disable no-console */
import * as pulumi from '@pulumi/pulumi';

const moduleDependencies: Record<string, string[]> = {
    data: ['cloudnative-pg', 'mariadb-operator'],
    hardware: ['amd-gpu-operator', 'nfd', 'nvidia-gpu-operator'],
    monitoring: ['beszel', 'prometheus'],
    security: ['pocket'],
};

class Config {
    private configs: Record<string, pulumi.Config> = {};

    constructor() {
        this.processDeprecated();
    }

    private getConfig(name: string): pulumi.Config {
        return (this.configs[name] ??= new pulumi.Config(name));
    }

    public helmHistoryLimit = 5;

    public isEnabled(name: string): boolean {
        return this.getBoolean(name, 'enabled') ?? false;
    }

    public enableMonitoring() {
        const prometheusEnabled = this.getBoolean('prometheus', 'enabled') ?? false;
        const componentsEnabled =
            this.getBoolean('prometheus', 'enableComponentMonitoring') ?? false;
        return prometheusEnabled && componentsEnabled;
    }

    public requireEnabled(appName: string, dependencyName: string) {
        if (!this.isEnabled(dependencyName)) {
            throw new Error(`${appName}: missing dependency ${dependencyName}`);
        }
    }

    public get(appName: string, key: string): string | undefined {
        return this.getConfig(appName).get(key);
    }

    public getObject(appName: string, key: string): unknown {
        return this.getConfig(appName).getObject(key);
    }

    public requireObject(appName: string, key: string): unknown {
        return this.getConfig(appName).requireObject(key);
    }

    public getCommaSeparated(appName: string, key: string): string[] | undefined {
        const value = this.get(appName, key);
        return value === undefined ? undefined : this.parseCommaSeparated(value);
    }

    public requireCommaSeparated(appName: string, key: string): string[] {
        const strings = this.parseCommaSeparated(this.require(appName, key));
        if (strings.length === 0) {
            throw new Error(`${appName}:${key} must contain at least one value.`);
        }
        return strings;
    }

    private parseCommaSeparated(value: string): string[] {
        return value
            .split(',')
            .map(item => item.trim())
            .filter(Boolean);
    }

    public require(appName: string, key: string): string {
        return this.getConfig(appName).require(key);
    }

    public getSecret(appName: string, key: string): pulumi.Output<string> | undefined {
        return this.getConfig(appName).getSecret(key);
    }

    public requireSecret(appName: string, key: string): pulumi.Output<string> {
        return this.getConfig(appName).requireSecret(key);
    }

    public getNumber(appName: string, key: string): number | undefined {
        return this.getConfig(appName).getNumber(key);
    }

    public requireNumber(appName: string, key: string): number {
        return this.getConfig(appName).requireNumber(key);
    }

    public requireEnum<T extends string>(
        appName: string,
        key: string,
        allowed: readonly T[],
    ): T {
        const value = this.require(appName, key);
        if (!allowed.includes(value as T)) {
            throw new Error(
                `${appName}:${key} has invalid value '${value}'. Use one of: ${allowed.join(', ')}.`,
            );
        }
        return value as T;
    }

    public getBoolean(appName: string, key: string): boolean | undefined {
        return this.getConfig(appName).getBoolean(key);
    }

    public requireBoolean(appName: string, key: string): boolean {
        return this.getConfig(appName).requireBoolean(key);
    }

    private processDeprecated() {
        if (this.get('longhorn', 'backupAccessKeyId')) {
            console.warn('longhorn:backupAccessKeyId is deprecated.');
        }
        if (this.get('longhorn', 'backupAccessKeySecret')) {
            console.warn('longhorn:backupAccessKeySecret is deprecated.');
        }
        if (this.get('longhorn', 'backupTarget')) {
            console.warn(
                'longhorn:backupTarget is deprecated. Use longhorn:backupBucket instead.',
            );
        }
        if (this.get('longhorn', 'backupBucketCreate')) {
            console.warn('longhorn:backupBucketCreate is deprecated.');
        }
        if (this.get('grafana', 'url')) {
            console.warn('grafana:url is not used anymore');
        }
        if (this.get('grafana', 'auth')) {
            console.warn('grafana:auth is not used anymore');
        }
        if (this.get('orangelab', 'storageClass-gpu')) {
            console.warn(
                'orangelab:storageClass-gpu is deprecated. Use per-app <app>:storageClass if needed.',
            );
        }
        if (this.get('orangelab', 'storageClass-large')) {
            console.warn(
                'orangelab:storageClass-large is deprecated. Use per-app <app>:storageClass if needed.',
            );
        }
        if (this.get('orangelab', 'storageClass-database')) {
            console.warn(
                'orangelab:storageClass-database is deprecated. Use per-app <app>:storageClass if needed.',
            );
        }
        if (this.get('mempool', 'db/maintenance')) {
            console.warn(
                'mempool:db/maintenance is deprecated. Use mempool:db/disableAuth instead.',
            );
        }
        if (this.get('tailscale', 'apiKey')) {
            console.warn('tailscale:apiKey is deprecated. Use tailscale OAuth instead.');
        }
        if (this.get('tailscale-operator', 'oauthClientId')) {
            console.warn(
                'tailscale-operator:oauthClientId is deprecated. Use tailscale:oauthClientId.',
            );
        }
        if (this.get('tailscale-operator', 'oauthClientSecret')) {
            console.warn(
                'tailscale-operator:oauthClientSecret is deprecated. Use tailscale:oauthClientSecret.',
            );
        }
        for (const app of [
            'bitcoin-core',
            'bitcoin-knots',
            'electrs',
            'mempool',
            'n8n',
            'sdnext',
            'automatic1111',
            'rustfs',
            'beszel',
            'invokeai',
        ]) {
            if (this.get(app, 'version')) {
                console.warn(`${app}:version is deprecated. Use ${app}:image instead.`);
            }
        }
        if (this.get('n8n', 'db/imageVersion')) {
            console.warn('n8n:db/imageVersion is deprecated. Use n8n:db/image instead.');
        }
    }

    /**
     * Returns true if any component in the given module is enabled.
     */
    public isModuleEnabled(module: string): boolean {
        const deps = moduleDependencies[module];
        return deps.some(dep => this.isEnabled(dep));
    }
}

export const config = new Config();
