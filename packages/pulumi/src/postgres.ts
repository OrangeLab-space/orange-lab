import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';
import { config } from './config';
import { Metadata } from './metadata';
import { Nodes } from './nodes';
import { DatabaseConfig } from './types';

export interface PostgresClusterArgs {
    name: string;
    metadata: Metadata;
    nodes: Nodes;
    storageSize: pulumi.Input<string>;
    storageClassName?: pulumi.Input<string>;
    enabled?: boolean;
    fromVolume?: string;
    instances?: number;
    password?: pulumi.Input<string>;
    imageName?: string;
    postInitApplicationSQL?: string[];
    sharedPreloadLibraries?: string[];
}

export class PostgresCluster extends pulumi.ComponentResource {
    private secret: kubernetes.core.v1.Secret;

    private dbPassword: pulumi.Output<string>;
    private dbUser: string;
    private clusterName: string;

    constructor(
        private appName: string,
        private args: PostgresClusterArgs,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super('orangelab:PostgresCluster', appName, args, opts);
        this.clusterName = `${appName}-${this.args.name}`;
        this.dbUser = appName;
        this.dbPassword = pulumi.output(
            this.args.password ?? this.createPassword(this.dbUser),
        );

        this.secret = this.createSecret();
        if (!args.enabled) return;

        this.createCluster();
    }

    private createSecret() {
        return new kubernetes.core.v1.Secret(
            `${this.clusterName}-secret`,
            {
                metadata: {
                    name: `${this.clusterName}-secret`,
                    namespace: this.args.metadata.namespace,
                    labels: { 'cnpg.io/watch': '' },
                },
                stringData: {
                    username: this.dbUser,
                    password: this.dbPassword,
                },
            },
            { parent: this },
        );
    }

    private createCluster(): kubernetes.apiextensions.CustomResource {
        const metadata = this.args.metadata.get({ component: this.args.name });
        const instances = this.args.instances ?? 1;
        const cluster = new kubernetes.apiextensions.CustomResource(
            this.clusterName,
            {
                apiVersion: 'postgresql.cnpg.io/v1',
                kind: 'Cluster',
                metadata,
                spec: {
                    affinity: this.args.nodes.getAffinity(this.args.name),
                    bootstrap: {
                        initdb: {
                            database: this.appName,
                            owner: this.dbUser,
                            secret: { name: this.secret.metadata.name },
                            postInitApplicationSQL: this.args.postInitApplicationSQL,
                        },
                    },
                    enablePDB: instances > 1,
                    imageName: this.args.imageName,
                    inheritedMetadata: { labels: metadata.labels },
                    instances,
                    monitoring: config.enableMonitoring()
                        ? { enablePodMonitor: true }
                        : undefined,
                    postgresql: this.args.sharedPreloadLibraries
                        ? { shared_preload_libraries: this.args.sharedPreloadLibraries }
                        : undefined,
                    resources: {
                        requests: { cpu: '100m', memory: '128Mi' },
                        limits: { memory: '1Gi' },
                    },
                    storage: {
                        size: this.args.storageSize,
                        ...(this.args.fromVolume
                            ? {}
                            : {
                                  pvcTemplate: {
                                      accessModes: ['ReadWriteOnce'],
                                      resources: {
                                          requests: { storage: this.args.storageSize },
                                      },
                                      storageClassName: this.args.storageClassName,
                                      volumeMode: 'Filesystem',
                                  },
                              }),
                    },
                },
            },
            { parent: this },
        );
        return cluster;
    }

    getConfig(): DatabaseConfig {
        return {
            name: this.args.name,
            hostname: pulumi.interpolate`${this.clusterName}-rw.${this.args.metadata.namespace}`,
            database: this.appName,
            username: this.dbUser,
            password: this.dbPassword,
            port: 5432,
        };
    }

    private createPassword(username: string) {
        return new random.RandomPassword(
            `${this.clusterName}-${username}-password`,
            { length: 32, special: false },
            { parent: this },
        ).result;
    }
}
