import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

export interface LonghornRecurringJobArgs {
    name: string;
    task: 'snapshot' | 'backup';
    cron: pulumi.Input<string>;
    retain: pulumi.Input<number>;
    parameters?: Record<string, pulumi.Input<string>>;
}

export class LonghornRecurringJob extends kubernetes.apiextensions.CustomResource {
    constructor(
        name: string,
        args: LonghornRecurringJobArgs,
        opts?: pulumi.CustomResourceOptions,
    ) {
        super(
            name,
            {
                apiVersion: 'longhorn.io/v1beta2',
                kind: 'RecurringJob',
                metadata: {
                    name: args.name,
                    namespace: 'longhorn-system',
                },
                spec: {
                    concurrency: 2,
                    cron: args.cron,
                    groups: [],
                    name: args.name,
                    parameters: args.parameters,
                    retain: args.retain,
                    task: args.task,
                },
            },
            opts,
        );
    }
}
