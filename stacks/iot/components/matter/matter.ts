import { Application, config } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

export class MatterServer extends pulumi.ComponentResource {
    public readonly endpointUrl?: pulumi.Input<string>;
    public readonly websocketUrl?: pulumi.Input<string>;

    constructor(name: string, opts?: pulumi.ResourceOptions) {
        super('orangelab:iot:MatterServer', name, {}, opts);

        const image = config.require(name, 'image');
        const bluetoothAdapter = config.getNumber(name, 'bluetoothAdapter') ?? 0;
        const bluetoothEnabled = bluetoothAdapter >= 0;
        const primaryInterface = config.get(name, 'primaryInterface');
        const app = new Application(this, name).addStorage();

        if (app.storageOnly) return;

        const httpEndpointInfo = app.network.getHttpEndpointInfo();

        // Host's D-Bus socket for Bluetooth (BlueZ) access, used to commission
        // Matter devices over BLE without a phone.
        if (bluetoothEnabled) {
            app.storage?.addDeviceMount({
                name: 'dbus',
                hostPath: '/run/dbus',
                type: 'Directory',
            });
        }

        app.addDeployment({
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
        });

        const clusterUrl = app.network.clusterEndpoints[name];
        this.websocketUrl = clusterUrl
            ? pulumi.output(clusterUrl).apply(url => `${url.replace(/^http/, 'ws')}/ws`)
            : undefined;
        this.endpointUrl = httpEndpointInfo.url;
    }
}
