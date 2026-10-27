import { Application } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

export class Prowlarr extends pulumi.ComponentResource {
    public readonly app: Application;

    constructor(
        private name: string,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super('orangelab:media:Prowlarr', name, {}, opts);

        this.app = new Application(this, name).addStorage();

        this.createDeployment();
    }

    private createDeployment() {
        return this.app.addDeployment({
            ports: [{ name: 'http', port: 9696 }],
            volumeMounts: [{ mountPath: '/config' }],
            env: {
                PUID: '1000',
                PGID: '1000',
            },
            resources: {
                requests: { cpu: '50m', memory: '256Mi' },
                limits: { cpu: '1', memory: '512Mi' },
            },
        });
    }
}
