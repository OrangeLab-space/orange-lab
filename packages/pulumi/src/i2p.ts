import { config } from './config';
import {
    ContainerResources,
    EmptyVolumeSpec,
    InitContainerSpec,
    SidecarSpec,
} from './types';

const samPort = 7656;
const i2pSidecarName = 'i2p';
const i2pdConfigFileName = 'i2pd.conf';
const i2pDataVolumeName = 'i2p-data';
const i2pPermissionsInitName = 'i2p-permissions';
const i2pdUserId = 100;

const defaultResources: ContainerResources = {
    requests: { cpu: '25m', memory: '64Mi' },
    limits: { cpu: '500m', memory: '512Mi' },
};

/**
 * The image used for every I2P sidecar. An app can pin a different version
 * with `<app>:i2p/image`; the shared default is in `Pulumi.yaml`.
 */
export function getI2pImage(appName: string): string {
    return config.get(appName, 'i2p/image') ?? config.require('orangelab', 'i2p/image');
}

export interface I2pSidecarArgs {
    /** The application name, used to resolve `<app>:i2p/image`. */
    appName: string;
    /** UID that owns the i2pd data directory. Defaults to the image's user (100). */
    runAsUser?: number;
    /** i2pd data directory. Defaults to `/home/i2pd/data`. */
    dataDir?: string;
    /** Name of the config volume that holds `i2pd.conf`. Defaults to `config`. */
    configVolumeName?: string;
    resources?: ContainerResources;
}

export interface I2pSidecar {
    sidecar: SidecarSpec;
    i2pdConf: string;
    volumes: EmptyVolumeSpec[];
    initContainers: InitContainerSpec[];
}

/** Validated sidecar arguments with defaults applied. */
interface I2pSidecarSettings {
    appName: string;
    runAsUser: number;
    dataDir: string;
    configVolumeName: string;
    resources: ContainerResources;
}

function resolveI2pSidecarSettings(args: I2pSidecarArgs): I2pSidecarSettings {
    const runAsUser = args.runAsUser ?? i2pdUserId;
    if (!Number.isInteger(runAsUser) || runAsUser <= 0) {
        throw new Error(`${args.appName}: the I2P sidecar needs a non-root runAsUser.`);
    }

    return {
        appName: args.appName,
        runAsUser,
        dataDir: args.dataDir ?? '/home/i2pd/data',
        configVolumeName: args.configVolumeName ?? 'config',
        resources: args.resources ?? defaultResources,
    };
}

function createI2pdConf(): string {
    return [
        'log = stdout',
        'loglevel = info',
        'daemon = false',
        'ipv4 = true',
        'ipv6 = false',
        '',
        '[sam]',
        'enabled = true',
        'address = 127.0.0.1',
        `port = ${String(samPort)}`,
        '',
        '[http]',
        'enabled = false',
        '',
        '[httpproxy]',
        'enabled = false',
        '',
        '[socksproxy]',
        'enabled = false',
        '',
        '[upnp]',
        'enabled = false',
        '',
        '[reseed]',
        'verify = true',
    ].join('\n');
}

function createI2pInitContainer({
    dataDir,
    runAsUser,
}: I2pSidecarSettings): InitContainerSpec {
    return {
        name: i2pPermissionsInitName,
        command: [
            'sh',
            '-c',
            `mkdir -p ${dataDir} && chmod 700 ${dataDir} && chown -R ${String(runAsUser)}:${String(runAsUser)} ${dataDir}`,
        ],
        volumeMounts: [{ name: i2pDataVolumeName, mountPath: dataDir }],
    };
}

function createI2pContainerSpec({
    appName,
    configVolumeName,
    dataDir,
    resources,
    runAsUser,
}: I2pSidecarSettings): SidecarSpec {
    return {
        name: i2pSidecarName,
        image: getI2pImage(appName),
        env: {
            DATA_DIR: dataDir,
            DEFAULT_ARGS: `--datadir=${dataDir}`,
        },
        volumeMounts: [
            { name: i2pDataVolumeName, mountPath: dataDir },
            {
                name: configVolumeName,
                mountPath: `${dataDir}/${i2pdConfigFileName}`,
                readOnly: true,
                subPath: i2pdConfigFileName,
            },
        ],
        resources,
        runAsUser,
        runAsGroup: runAsUser,
    };
}

/**
 * An i2pd router that runs beside an application and exposes a SAM bridge on
 * localhost. It never listens on a public address; the app uses SAM to reach
 * I2P peers and accept inbound I2P connections.
 */
export function createI2pSidecar(args: I2pSidecarArgs): I2pSidecar {
    const settings = resolveI2pSidecarSettings(args);

    return {
        sidecar: createI2pContainerSpec(settings),
        i2pdConf: createI2pdConf(),
        volumes: [{ name: i2pDataVolumeName, sizeLimit: '256Mi' }],
        initContainers: [createI2pInitContainer(settings)],
    };
}
