import {
    Application,
    GpuType,
    InitContainerSpec,
    VolumeMount,
    config,
} from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

export interface FrigateDevice {
    name: string;
    device: string;
}

export interface FrigateMqttConfig {
    host: pulumi.Input<string>;
    port?: number;
    username?: string;
    password?: pulumi.Input<string>;
}

export interface FrigateArgs {
    mqtt?: FrigateMqttConfig;
}

export class Frigate extends pulumi.ComponentResource {
    public readonly endpointUrl?: pulumi.Input<string>;

    constructor(name: string, args: FrigateArgs, opts?: pulumi.ResourceOptions) {
        super('orangelab:iot:Frigate', name, args, opts);

        const coral = config.requireBoolean(name, 'coral');
        const devices =
            (config.getObject(name, 'devices') as FrigateDevice[] | undefined) ?? [];
        const recreateConfig = config.requireBoolean(name, 'config/recreate');

        app.addStorage();
        this.addMediaStorage(app, name);
        app.addEmptyVolume({
            name: 'shm',
            memory: true,
            sizeLimit: config.require(name, 'shmSize'),
        });
        app.addEmptyVolume({
            name: 'cache',
            memory: true,
            sizeLimit: config.require(name, 'cacheSize'),
        });

        if (coral) {
            app.storage?.addDeviceMount({
                name: 'usb',
                hostPath: '/dev/bus/usb',
                type: 'Directory',
            });
        }
        for (const { name: deviceName, device } of devices) {
            app.storage?.addDeviceMount({ name: deviceName, hostPath: device });
        }

        app.addConfigVolume({
            name: 'config-yml',
            secretFiles: {
                'config.yml': this.createConfig(name, {
                    coral,
                    gpu: app.nodes.getGpu(),
                    mqtt: args.mqtt,
                }),
            },
        });
        if (app.storageOnly) return;

        app.addDeployment({
            env: { TZ: config.get(name, 'TZ') },
            envSecret: { FRIGATE_MQTT_PASSWORD: args.mqtt?.password },
            healthCheck: { httpGet: { path: '/' } },
            initContainers: [this.createSeedInitContainer(name, recreateConfig)],
            ports: [
                { name: 'http', port: 5000, private: true },
                { name: 'auth', port: 8971 },
                { name: 'rtsp', port: 8554, private: true },
                { name: 'webrtc-tcp', port: 8555, protocol: 'tcp', private: true },
                { name: 'webrtc-udp', port: 8555, protocol: 'udp', private: true },
            ],
            resources: {
                requests: { cpu: '500m', memory: '512Mi' },
                limits: { memory: '4Gi' },
            },
            volumeMounts: this.createVolumeMounts(name, coral, devices),
        });

        this.endpointUrl = app.network.endpoints[`${name}-auth`];
    }

    private addMediaStorage(app: Application, name: string) {
        const hostPath = config.get(name, 'media/hostPath');
        if (hostPath) {
            app.addLocalStorage({ name: 'media', hostPath });
        } else {
            app.addStorage({ name: 'media' });
        }
    }

    private createVolumeMounts(
        appName: string,
        coral: boolean,
        devices: FrigateDevice[],
    ): VolumeMount[] {
        return [
            { mountPath: '/config', name: appName },
            { mountPath: '/media/frigate', name: 'media' },
            { mountPath: '/dev/shm', name: 'shm' },
            { mountPath: '/tmp/cache', name: 'cache' },
            ...(coral
                ? [{ mountPath: '/dev/bus/usb', name: 'usb', readOnly: true }]
                : []),
            ...devices.map(({ name, device }) => ({ mountPath: device, name })),
        ];
    }

    /**
     * Frigate's UI owns `config.yml` once deployed, so the Pulumi-managed file
     * is only copied into the writable data volume when missing or empty. Set
     * `config/recreate` to overwrite it (and reset UI changes) on the next deploy.
     */
    private createSeedInitContainer(
        appName: string,
        recreate: boolean,
    ): InitContainerSpec {
        const source = '/config-seed/config.yml';
        const target = '/config/config.yml';
        const copy = recreate
            ? `cp -f ${source} ${target}`
            : `[ -s ${target} ] || cp ${source} ${target}`;
        return {
            name: 'seed-config',
            command: ['sh', '-c', copy],
            volumeMounts: [
                { mountPath: '/config', name: appName },
                { mountPath: '/config-seed', name: 'config-yml', readOnly: true },
            ],
        };
    }
    private createConfig(
        name: string,
        args: {
            coral: boolean;
            gpu?: GpuType;
            mqtt?: FrigateMqttConfig;
        },
    ): pulumi.Output<string> {
        const configured: pulumi.Output<Record<string, unknown> | undefined> =
            config.getSecretObject<Record<string, unknown>>(name, 'config') ??
            pulumi.output<Record<string, unknown> | undefined>(undefined);
        return configured.apply(frigateConfig =>
            pulumi.output(this.getMqtt(args.mqtt)).apply(mqtt =>
                JSON.stringify(
                    {
                        ...(frigateConfig ?? {}),
                        cameras: frigateConfig?.cameras ?? this.getDefaultCameras(),
                        detectors:
                            frigateConfig?.detectors ?? this.getDetectors(args),
                        mqtt: frigateConfig?.mqtt ?? mqtt,
                        // TLS is terminated by the routing provider (Traefik/Tailscale).
                        tls: frigateConfig?.tls ?? { enabled: false },
                    },
                    undefined,
                    2,
                ),
            ),
        );
    }

    private getDefaultCameras() {
        return {
            dummy: {
                enabled: false,
                ffmpeg: {
                    inputs: [{ path: 'rtsp://127.0.0.1:554/rtsp', roles: ['detect'] }],
                },
            },
        };
    }

    private getDetectors(args: { coral: boolean; gpu?: GpuType }) {
        if (args.coral) return { coral: { type: 'edgetpu', device: 'usb' } };
        if (args.gpu === 'nvidia') return { tensorrt: { type: 'tensorrt' } };
        if (args.gpu === 'amd') return { rocm: { type: 'rocm' } };
        return { cpu: { type: 'cpu' } };
    }

    private getMqtt(mqtt?: FrigateMqttConfig) {
        if (!mqtt) return { enabled: false };
        return {
            enabled: true,
            host: mqtt.host,
            port: mqtt.port ?? 1883,
            ...(mqtt.username ? { user: mqtt.username } : {}),
            ...(mqtt.password ? { password: '{FRIGATE_MQTT_PASSWORD}' } : {}),
        };
    }
}
