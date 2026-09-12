import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';
import assert from 'node:assert';
import { Auth, OidcAuthConfig, OidcProviderSettings } from './auth';
import { config } from './config';
import { Databases } from './databases';
import { Metadata } from './metadata';
import { Network } from './network';
import { Nodes } from './nodes';
import { Services } from './services';
import { Smtp } from './smtp';
import { Storage } from './storage';
import {
    ConfigVolumeSpec,
    ContainerSpec,
    LocalVolumeSpec,
    PersistentVolumeSpec,
} from './types';

/**
 * Application class provides DSL (Domain Specific Language) to simplify creation of Kubernetes manifests.
 *
 * Limitations:
 * - max one DaemonSet
 * - no endpoints for DaemonSet
 * - persistent storage for DaemonSets not supported
 */
export class Application {
    storageOnly = false;
    readonly metadata: Metadata;
    readonly nodes: Nodes;
    readonly network: Network;
    readonly auth: Auth;
    readonly smtp: Smtp;
    /** Resolved OIDC client settings for native application authentication or route protection. */
    readonly oidc?: OidcAuthConfig;
    readonly debug: boolean;
    databases?: Databases;
    storage?: Storage;

    private services?: Services;

    constructor(
        private readonly scope: pulumi.ComponentResource,
        private readonly appName: string,
        args?: {
            namespace?: string;
            existingNamespace?: string;
            /** OIDC provider settings; route protection is opt-in for edge-only applications. */
            oidc?: OidcProviderSettings;
        },
    ) {
        this.processDeprecated();
        this.storageOnly = config.getBoolean(appName, 'storageOnly') ?? false;
        this.debug = config.getBoolean(appName, 'debug') ?? false;
        this.auth = new Auth(appName);
        this.smtp = new Smtp(appName);
        this.oidc = this.auth.getOidc(args?.oidc);
        const routeOidc = args?.oidc?.protectRoutes ? this.oidc : undefined;
        this.metadata = new Metadata(
            appName,
            {
                namespace: args?.namespace,
                existingNamespace: args?.existingNamespace,
            },
            { parent: this.scope },
        );
        this.nodes = new Nodes({ appName });
        this.network = new Network(
            appName,
            {
                metadata: this.metadata,
                oidc: routeOidc,
                pluginSecret: routeOidc
                    ? config.getSecret(appName, 'auth/pluginSecret') ??
                      this.createPassword('oidc-secret')
                    : undefined,
            },
            { parent: this.scope },
        );
    }

    private processDeprecated() {
        assert(
            !config.get(this.appName, 'fromBackup'),
            `${this.appName}:fromBackup is not supported. Use fromVolume instead.`,
        );
        assert(
            !config.get(this.appName, 'cloneFromClaim'),
            `${this.appName}:cloneFromClaim is not supported. Use fromVolume instead.`,
        );
        assert(
            !config.get(this.appName, 'amd-gpu'),
            `${this.appName}:amd-gpu is deprecated. Use ${this.appName}:gpu instead (amd|nvidia).`,
        );
    }

    private getStorage() {
        this.storage =
            this.storage ??
            new Storage(
                this.appName,
                {
                    metadata: this.metadata,
                    nodes: this.nodes,
                },
                { parent: this.scope },
            );
        return this.storage;
    }

    private getDatabases() {
        this.databases =
            this.databases ??
            new Databases(
                this.appName,
                {
                    metadata: this.metadata,
                    nodes: this.nodes,
                    storage: this.getStorage(),
                    storageOnly: this.storageOnly,
                },
                { parent: this.scope },
            );
        return this.databases;
    }

    private getServices() {
        this.services =
            this.services ??
            new Services(
                this.appName,
                {
                    metadata: this.metadata,
                    storage: this.storage,
                    nodes: this.nodes,
                },
                { parent: this.scope },
            );
        return this.services;
    }

    /**
     * Adds a MariaDB database using the MariaDB Operator CRD.
     * Creates a database, user and storage.
     */
    addMariaDB() {
        this.getDatabases().addMariaDB();
        return this;
    }

    /**
     * Adds a PostgreSQL database using the CloudNativePG Operator CRD.
     * Creates a database, user and storage.
     */
    addPostgres() {
        this.getDatabases().addPostgres();
        return this;
    }

    addRedis() {
        this.getDatabases().addRedis();
        return this;
    }

    addStorage(volume?: PersistentVolumeSpec) {
        this.getStorage().addPersistentVolume(volume);
        return this;
    }

    addLocalStorage(volume: LocalVolumeSpec) {
        this.getStorage().addLocalVolume(volume);
        return this;
    }

    /**
     * Adds a config volume that contains multiple configuration files mounted in the same folder.
     * Supports both regular files (ConfigMap) and secret files (Secret).
     * @param configVolume The config volume definition (name, files, and/or secretFiles)
     */
    addConfigVolume(configVolume: ConfigVolumeSpec) {
        if (this.storageOnly) return this;
        this.getStorage().addConfigVolume(configVolume);
        return this;
    }

    addDeployment(spec: ContainerSpec) {
        if (this.storageOnly) return this;
        this.getServices().createDeployment(spec);
        this.network.createEndpoints(spec);
        return this;
    }

    createPassword(name: string, args?: { length?: number }) {
        return new random.RandomPassword(
            `${this.appName}-${name}`,
            { length: args?.length ?? 32, special: false },
            { parent: this.scope },
        ).result;
    }

    /**
     * Adds a caddy reverse proxy deployment that exposes a hostNetwork app
     * through the standard routing provider (Traefik/Tailscale).
     * Uses Caddy as reverse-proxy to application pod.
     */
    addHostNetworkProxy(spec: {
        targetPort: number;
        serviceAccountName?: pulumi.Input<string>;
    }) {
        if (this.storageOnly) return this;
        const httpEndpointInfo = this.network.getHttpEndpointInfo();
        this.addDeployment({
            name: 'proxy',
            image: 'caddy:2-alpine',
            command: ['caddy'],
            commandArgs: this.metadata.namespace.apply(ns => [
                'reverse-proxy',
                '--from',
                ':8080',
                '--to',
                `http://${this.appName}.${ns}:${String(spec.targetPort)}`,
            ]),
            hostname: httpEndpointInfo.host,
            ports: [{ name: 'http', port: 8080 }],
            resources: {
                limits: { memory: '64Mi' },
                requests: { cpu: '10m', memory: '32Mi' },
            },
            serviceAccountName: spec.serviceAccountName,
        });
        return this;
    }

    addDaemonSet(spec: ContainerSpec) {
        if (this.storageOnly) return this;
        this.getServices().createDaemonSet(spec);
        return this;
    }

    addJob(spec: ContainerSpec) {
        if (this.storageOnly) return this;
        this.getServices().createJob(spec);
        return this;
    }

    addHelmChart(
        name: string,
        args: {
            chart: string;
            repo: string;
            values?: pulumi.Inputs;
            httpRoute?: {
                componentName?: string;
                hostname?: string;
                serviceName: pulumi.Input<string>;
                servicePort: number;
            };
            skipCrds?: boolean;
        },
        opts?: pulumi.CustomResourceOptions,
    ) {
        const isOci = args.repo.startsWith('oci://');
        const chart = new kubernetes.helm.v3.Release(
            name,
            {
                chart: isOci ? `${args.repo}/${args.chart}` : args.chart,
                namespace: this.metadata.namespace,
                version: config.get(this.appName, 'version'),
                repositoryOpts: isOci ? undefined : { repo: args.repo },
                maxHistory: config.helmHistoryLimit,
                skipCrds: args.skipCrds,
                values: args.values,
            },
            { ...opts, parent: this.scope },
        );
        if (args.httpRoute) {
            const endpoint = this.network.getHttpEndpointInfo(
                args.httpRoute.hostname ?? config.require(this.appName, 'hostname'),
            );
            this.network.createHttpRoute(
                {
                    componentName: args.httpRoute.componentName ?? name,
                    hostname: endpoint.hostname,
                    serviceName: args.httpRoute.serviceName,
                    servicePort: args.httpRoute.servicePort,
                    middlewareName: this.network.oidcMiddlewareName,
                },
                { parent: this.scope, dependsOn: [chart] },
            );
        }
        return chart;
    }
}
