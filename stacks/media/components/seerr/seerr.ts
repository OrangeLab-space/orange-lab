import { Application } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

export class Seerr extends pulumi.ComponentResource {
    public readonly app: Application;

    constructor(
        private name: string,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super('orangelab:media:Seerr', name, {}, opts);

        this.app = new Application(this, name).addStorage().addDeployment({
            ports: [{ name: 'http', port: 5055 }],
            resources: {
                requests: { memory: '128Mi' },
                limits: { memory: '512Mi' },
            },
            volumeMounts: [{ mountPath: '/app/config' }],
            volumeOwnerUserId: 1000,
            });
    }
}
