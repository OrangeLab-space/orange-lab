import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { Metadata } from './metadata';
import { Nodes } from './nodes';
import { REDIS_RESOURCES, withResources } from './resources';
import { ContainerResources, DatabaseConfig } from './types';

export interface RedisArgs {
    metadata: Metadata;
    nodes: Nodes;
    image: string;
    /** Overrides the default cpu and memory requests and limits. */
    resources?: ContainerResources;
}

export class Redis extends pulumi.ComponentResource {
    private serviceName: string;

    constructor(
        appName: string,
        private args: RedisArgs,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super('orangelab:Redis', appName, args, opts);

        this.serviceName = `${appName}-redis`;
        this.createDeployment();
        this.createService();
    }

    private createDeployment() {
        return new kubernetes.apps.v1.Deployment(
            `${this.serviceName}-deployment`,
            {
                metadata: {
                    name: this.serviceName,
                    namespace: this.args.metadata.namespace,
                },
                spec: {
                    replicas: 1,
                    selector: {
                        matchLabels: {
                            app: this.serviceName,
                        },
                    },
                    template: {
                        metadata: {
                            labels: {
                                app: this.serviceName,
                            },
                        },
                        spec: {
                            affinity: this.args.nodes.getAffinity(),
                            containers: [
                                {
                                    name: 'redis',
                                    image: this.args.image,
                                    ports: [
                                        {
                                            containerPort: 6379,
                                            name: 'redis',
                                        },
                                    ],
                                    resources: withResources(
                                        REDIS_RESOURCES,
                                        this.args.resources,
                                    ),
                                },
                            ],
                        },
                    },
                },
            },
            { parent: this },
        );
    }

    private createService() {
        return new kubernetes.core.v1.Service(
            `${this.serviceName}-service`,
            {
                metadata: {
                    name: this.serviceName,
                    namespace: this.args.metadata.namespace,
                },
                spec: {
                    selector: {
                        app: this.serviceName,
                    },
                    ports: [
                        {
                            port: 6379,
                            targetPort: 6379,
                            name: 'redis',
                        },
                    ],
                },
            },
            { parent: this },
        );
    }

    getConfig(): DatabaseConfig {
        return {
            name: 'redis',
            hostname: pulumi.interpolate`${this.serviceName}.${this.args.metadata.namespace}`,
            database: '',
            username: '',
            password: '',
            port: 6379,
        };
    }
}
