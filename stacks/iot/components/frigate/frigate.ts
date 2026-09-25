import {
    Application,
    GpuType,
    InitContainerSpec,
    VolumeMount,
    config,
} from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';
import { stringify as yamlStringify } from 'yaml';

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

/** GPUs that map to a Frigate image variant. Other accelerators use the default image. */
const IMAGE_VARIANTS: Record<string, string> = { nvidia: 'tensorrt', amd: 'rocm' };

export class Frigate extends pulumi.ComponentResource {
    public readonly endpointUrl?: pulumi.Input<string>;
    public readonly proxySecret?: pulumi.Input<string>;

    constructor(name: string, args: FrigateArgs, opts?: pulumi.ResourceOptions) {
        super('orangelab:iot:Frigate', name, args, opts);

        const coral = config.requireBoolean(name, 'coral');
        const devices =
            (config.getObject(name, 'devices') as FrigateDevice[] | undefined) ?? [];
        const recreateConfig = config.requireBoolean(name, 'config/recreate');
        this.proxySecret = this.getProxySecret(name);
        const app = new Application(
            this,
            name,
            this.proxySecret
                ? {
                      oidc: {
                          protectRoutes: true,
                          forwardIdentity: true,
                          headers: { 'X-Proxy-Secret': this.proxySecret },
                      },
                  }
                : undefined,
        );
        const gpu = app.nodes.getGpu();

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
                    gpu,
                    mqtt: args.mqtt,
                    proxySecret: this.proxySecret,
                }),
            },
        });
        if (app.storageOnly) return;

        app.addDeployment({
            image: this.getImage(name, gpu),
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

    /** Frigate image with the `frigate:gpu` variant appended to the tag. */
    private getImage(name: string, gpu?: GpuType): string {
        const image = config.require(name, 'image');
        if (image.includes('@')) return image;
        const tag = /:([^/:]+)$/.exec(image)?.[1];
        const repo = tag ? image.slice(0, -(tag.length + 1)) : image;
        const base = tag ?? 'stable';
        const variant = gpu ? IMAGE_VARIANTS[gpu] : undefined;
        if (!variant || base.endsWith(`-${variant}`)) return `${repo}:${base}`;
        return `${repo}:${base}-${variant}`;
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
            ? `cp -vf ${source} ${target}`
            : `[ -s ${target} ] || cp -v ${source} ${target}`;
        return {
            name: 'seed-config',
            command: ['sh', '-c', copy],
            volumeMounts: [
                { mountPath: '/config', name: appName },
                { mountPath: '/config-seed', name: 'config-yml', readOnly: true },
            ],
        };
    }

    /**
     * Shared secret for the Traefik OIDC middleware and Frigate's proxy auth.
     * Only generated when SSO is enabled via `frigate:auth`.
     */
    private getProxySecret(name: string): pulumi.Input<string> | undefined {
        if (config.get(name, 'auth') === undefined) return undefined;
        return new random.RandomPassword(
            `${name}-proxy-secret`,
            { length: 32, special: false },
            { parent: this },
        ).result;
    }

    private createConfig(
        name: string,
        args: {
            coral: boolean;
            gpu?: GpuType;
            mqtt?: FrigateMqttConfig;
            proxySecret?: pulumi.Input<string>;
        },
    ): pulumi.Output<string> {
        const configured: pulumi.Output<Record<string, unknown> | undefined> =
            config.getSecretObject<Record<string, unknown>>(name, 'config') ??
            pulumi.output<Record<string, unknown> | undefined>(undefined);
        return pulumi
            .all([
                configured,
                pulumi.output(this.getMqtt(args.mqtt)),
                pulumi.output(args.proxySecret),
            ])
            .apply(([frigateConfig, mqtt, proxySecret]) => {
                const userConfig = (frigateConfig ?? {}) as Record<string, unknown>;
                return yamlStringify(
                    {
                        ...userConfig,
                        ...this.getAuthConfig(name, proxySecret),
                        cameras: userConfig.cameras ?? this.getDefaultCameras(),
                        detectors: userConfig.detectors ?? this.getDetectors(args),
                        ...(this.getOpenVinoModel(args, userConfig) ?? {}),
                        mqtt: userConfig.mqtt ?? mqtt,
                        // TLS is terminated by the routing provider (Traefik/Tailscale).
                        tls: userConfig.tls ?? { enabled: false },
                    },
                    { lineWidth: 0 },
                );
            });
    }

    /**
     * Disables Frigate's own authentication and trusts the Pocket ID groups
     * forwarded by the Traefik OIDC middleware (see `forwardIdentity`).
     */
    private getAuthConfig(name: string, proxySecret?: string) {
        if (!proxySecret) return {};
        const groupMap = config.requireObject(name, 'auth/groupMap') as Record<
            string,
            string[]
        >;
        const defaultRole = config.requireEnum(name, 'auth/defaultRole', [
            'admin',
            'viewer',
        ]);
        return {
            auth: { enabled: false },
            proxy: {
                auth_secret: proxySecret,
                header_map: {
                    user: 'x-forwarded-user',
                    role: 'x-forwarded-groups',
                    role_map: groupMap,
                },
                default_role: defaultRole,
                logout_url: '/logout',
            },
        };
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

    /** OpenVINO on an Intel iGPU, else Coral, else CPU. */
    private getDetectors(args: { coral: boolean; gpu?: GpuType }) {
        if (args.gpu === 'intel') return { ov: { type: 'openvino', device: 'GPU' } };
        if (args.coral) return { coral: { type: 'edgetpu', device: 'usb' } };
        return { cpu: { type: 'cpu' } };
    }

    /**
     * Workaround: Frigate sizes detector shared memory from the per-detector model
     * but runs DetectProcess with the root `model`, so OpenVINO's built-in 300x300
     * model must be mirrored in the root (else 320x320 shm and a shifted labelmap).
     */
    private getOpenVinoModel(
        args: { gpu?: GpuType },
        userConfig: Record<string, unknown>,
    ): { model: Record<string, unknown> } | undefined {
        if (args.gpu !== 'intel' || userConfig.model || userConfig.detectors) {
            return undefined;
        }
        return {
            model: {
                path: '/openvino-model/ssdlite_mobilenet_v2.xml',
                labelmap_path: '/openvino-model/coco_91cl_bkgr.txt',
                width: 300,
                height: 300,
                input_tensor: 'nhwc',
                input_pixel_format: 'bgr',
            },
        };
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
