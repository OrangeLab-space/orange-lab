import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { Metadata } from './metadata';
import { createPassword } from './secrets';
import { DatabaseConfig } from './types';

export interface MariaDbClusterArgs {
    affinity?: kubernetes.types.input.core.v1.Affinity;
    disableAuth?: boolean;
    enabled?: boolean;
    metadata: Metadata;
    name: string;
    password?: pulumi.Input<string>;
    rootPassword?: pulumi.Input<string>;
    storageClassName?: pulumi.Input<string>;
    storageOnly?: boolean;
    storageSize: pulumi.Input<string>;
}

export class MariaDbCluster extends pulumi.ComponentResource {
    private secret: kubernetes.core.v1.Secret;

    private dbPassword: pulumi.Output<string>;
    private rootPassword: pulumi.Output<string>;
    private dbUser: string;
    private clusterName: string;

    constructor(
        private appName: string,
        private args: MariaDbClusterArgs,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super('orangelab:MariaDbCluster', appName, args, opts);
        this.clusterName = `${appName}-${this.args.name}`;
        this.dbUser = appName;
        this.dbPassword = pulumi.output(
            args.password ??
                createPassword(this, `${this.clusterName}-${this.dbUser}-password`),
        );
        this.rootPassword = pulumi.output(
            this.args.rootPassword ??
                createPassword(this, `${this.clusterName}-root-password`),
        );

        this.secret = this.createCredentialsSecret();
        if (!args.enabled) return;
        this.createCluster();
    }

    private createCredentialsSecret() {
        return new kubernetes.core.v1.Secret(
            `${this.clusterName}-secret`,
            {
                metadata: {
                    name: `${this.clusterName}-secret`,
                    namespace: this.args.metadata.namespace,
                    labels: { 'k8s.mariadb.com/watch': '' },
                },
                stringData: {
                    username: this.dbUser,
                    password: this.dbPassword,
                    rootPassword: this.rootPassword,
                },
            },
            { parent: this },
        );
    }

    private createCluster(): kubernetes.apiextensions.CustomResource {
        const metadata = this.args.metadata.get({ component: this.args.name });
        const myCnf = pulumi.interpolate`
        [mariadb]
        skip-name-resolve
        temp-pool
        ${this.args.disableAuth ? 'skip-grant-tables' : ''}
        ${this.args.disableAuth ? 'skip-networking' : ''}
        `;
        return new kubernetes.apiextensions.CustomResource(
            this.clusterName,
            {
                apiVersion: 'k8s.mariadb.com/v1alpha1',
                kind: 'MariaDB',
                metadata,
                spec: {
                    affinity: this.args.affinity,
                    database: this.appName,
                    inheritMetadata: { labels: metadata.labels },
                    metrics: { enabled: true },
                    myCnf,
                    passwordSecretKeyRef: {
                        name: this.secret.metadata.name,
                        key: 'password',
                        generate: false,
                    },
                    replicas: 1,
                    resources: {
                        requests: { cpu: '100m', memory: '128Mi' },
                        limits: { memory: '1Gi' },
                    },
                    rootPasswordSecretKeyRef: {
                        name: this.secret.metadata.name,
                        key: 'rootPassword',
                        generate: false,
                    },
                    storage: {
                        volumeClaimTemplate: {
                            accessModes: ['ReadWriteOnce'],
                            resources: {
                                requests: { storage: this.args.storageSize },
                            },
                            storageClassName: this.args.storageClassName,
                        },
                    },
                    suspend: false,
                    username: this.dbUser,
                },
            },
            { parent: this },
        );
    }

    getConfig(): DatabaseConfig {
        return {
            name: this.args.name,
            hostname: this.clusterName,
            database: this.appName,
            username: this.appName,
            password: this.dbPassword,
            port: 3306,
        };
    }
}
