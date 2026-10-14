import { Application, config } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

export class OpenThreadBorderRouter extends pulumi.ComponentResource {
    public readonly app: Application;

    constructor(name: string, opts?: pulumi.ResourceOptions) {
        super('orangelab:iot:OpenThreadBorderRouter', name, {}, opts);

        const device = config.require(name, 'device');
        const image = config.require(name, 'image');
        this.app = new Application(this, name).addStorage();

        if (this.app.storageOnly) return;

        this.app.storage?.addDeviceMount({ name: 'rcp', hostPath: device });
        this.app.storage?.addDeviceMount({ name: 'tun', hostPath: '/dev/net/tun' });
        this.app.addDeployment({
            env: {
                OT_REST_LISTEN_ADDR: '0.0.0.0',
                // The host network interface OTBR uses to reach the IP network.
                OT_INFRA_IF: config.require(name, 'OT_INFRA_IF'),
                OT_RCP_DEVICE: pulumi.interpolate`spinel+hdlc+uart://${device}?uart-baudrate=460800`,
                OT_THREAD_IF: 'wpan0',
            },
            hostNetwork: true,
            image,
            ports: [{ name: 'rest', port: 8081, private: true }],
            volumeMounts: [
                { mountPath: '/data' },
                { mountPath: device, name: 'rcp' },
                { mountPath: '/dev/net/tun', name: 'tun' },
            ],
        });

    }
}
