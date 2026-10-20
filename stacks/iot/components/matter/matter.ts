import { Application, config } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

export class MatterServer extends pulumi.ComponentResource {
    public readonly app: Application;

    constructor(name: string, opts?: pulumi.ResourceOptions) {
        super('orangelab:iot:MatterServer', name, {}, opts);

        const image = config.require(name, 'image');
        const bluetoothAdapter = config.getNumber(name, 'bluetoothAdapter') ?? 0;
        const bluetoothEnabled = bluetoothAdapter >= 0;
        const primaryInterface = config.get(name, 'primaryInterface');
        this.app = new Application(this, name).addStorage();

        if (this.app.storageOnly) return;

        // Host's D-Bus socket for Bluetooth (BlueZ) access, used to commission
        // Matter devices over BLE without a phone.
        if (bluetoothEnabled) {
            this.app.storage?.addDeviceMount({
                name: 'dbus',
                hostPath: '/run/dbus',
                type: 'Directory',
            });
        }

        this.app.addDeployment({
            hostNetwork: true,
            image,
            runAsUser: 1000,
            volumeOwnerUserId: 1000,
            env: {
                PRODUCTION_MODE: 'true',
                PRIMARY_INTERFACE: primaryInterface,
                ...(bluetoothEnabled
                    ? {
                          NOBLE_BINDINGS: 'dbus',
                          BLUETOOTH_ADAPTER: String(bluetoothAdapter),
                      }
                    : {}),
            },
            ports: [{ name: 'http', port: 5580 }],
            volumeMounts: [
                { mountPath: '/data' },
                ...(bluetoothEnabled
                    ? [{ mountPath: '/run/dbus', name: 'dbus', readOnly: true }]
                    : []),
            ],
            resources: {
                requests: { cpu: '100m', memory: '384Mi' },
                limits: { cpu: '1', memory: '768Mi' },
            },
        });

        const clusterUrl = this.app.network.clusterEndpoints[name];
        if (clusterUrl) {
            this.app.network.addClusterEndpoint(
                `${name}-websocket`,
                pulumi.output(clusterUrl).apply(url => `${url.replace(/^http/, 'ws')}/ws`),
            );
        }
    }
}
