import { config } from './config';
import {
    ContainerResources,
    EmptyVolumeSpec,
    InitContainerSpec,
    SidecarSpec,
    VolumeMount,
} from './types';

const socksPort = 9050;
const controlPort = 9051;
const torSidecarName = 'tor';
const torConfigFileName = 'torrc';
const torDataVolumeName = 'tor-data';
const torRunVolumeName = 'tor-run';
const torPermissionsInitName = 'tor-permissions';

const defaultResources: ContainerResources = {
    requests: { cpu: '10m', memory: '64Mi' },
    limits: { cpu: '250m', memory: '256Mi' },
};

/**
 * The image used for every Tor sidecar. An app can pin a different version
 * with `<app>:tor/image`; the shared default is in `Pulumi.yaml`.
 */
export function getTorImage(appName: string): string {
    return config.get(appName, 'tor/image') ?? config.require('orangelab', 'tor/image');
}

export interface TorSidecarArgs {
    /** The application name, used to resolve `<app>:tor/image`. */
    appName: string;
    /** UID the Tor process and the app must share to read the control cookie. */
    runAsUser: number;
    /** Enable the Tor control port so the app can create an onion service. */
    control?: boolean;
    /** Enable the SOCKS port for outbound `.onion` connections. */
    socks?: boolean;
    /** Tor data directory. Defaults to `/var/lib/tor`. */
    dataDir?: string;
    /** Directory holding the control cookie. Defaults to `/run/tor`. */
    runDir?: string;
    /** Name of the config volume that holds `torrc`. Defaults to `config`. */
    configVolumeName?: string;
    /** Directory the config volume's `torrc` is mounted into. Defaults to `/etc/tor`. */
    configMountPath?: string;
    resources?: ContainerResources;
}

export interface TorSidecar {
    sidecar: SidecarSpec;
    torrc: string;
    volumes: EmptyVolumeSpec[];
    initContainers: InitContainerSpec[];
    /**
     * Mounts the main container needs when the control port is enabled. The
     * app reads the control cookie from here.
     */
    mainVolumeMounts: VolumeMount[];
}

/** Validated sidecar arguments with defaults applied. */
interface TorSidecarSettings {
    appName: string;
    control: boolean;
    socks: boolean;
    runAsUser: number;
    dataDir: string;
    runDir: string;
    configVolumeName: string;
    configMountPath: string;
    resources: ContainerResources;
}

function resolveTorSidecarSettings(args: TorSidecarArgs): TorSidecarSettings {
    const control = args.control ?? false;
    const socks = args.socks ?? true;
    if (!control && !socks) {
        throw new Error(
            `${args.appName}: the Tor sidecar needs control, socks, or both.`,
        );
    }
    if (!Number.isInteger(args.runAsUser) || args.runAsUser <= 0) {
        throw new Error(
            `${args.appName}: the Tor sidecar needs a non-root runAsUser so the app can read the control cookie.`,
        );
    }

    return {
        appName: args.appName,
        control,
        socks,
        runAsUser: args.runAsUser,
        dataDir: args.dataDir ?? '/var/lib/tor',
        runDir: args.runDir ?? '/run/tor',
        configVolumeName: args.configVolumeName ?? 'config',
        configMountPath: args.configMountPath ?? '/etc/tor',
        resources: args.resources ?? defaultResources,
    };
}

function createTorrc({ control, socks, dataDir, runDir }: TorSidecarSettings): string {
    return [
        `DataDirectory ${dataDir}`,
        `SocksPort ${socks ? `127.0.0.1:${String(socksPort)}` : '0'}`,
        `ControlPort ${control ? `127.0.0.1:${String(controlPort)}` : '0'}`,
        ...(control
            ? [
                  'CookieAuthentication 1',
                  `CookieAuthFile ${runDir}/control_auth_cookie`,
                  'CookieAuthFileGroupReadable 1',
              ]
            : []),
        'ClientOnly 1',
        'MaxMemInQueues 128 MB',
        'AvoidDiskWrites 1',
        'Log notice stdout',
    ].join('\n');
}

function createTorInitContainer({
    dataDir,
    runAsUser,
    runDir,
}: TorSidecarSettings): InitContainerSpec {
    return {
        name: torPermissionsInitName,
        command: [
            'sh',
            '-c',
            `mkdir -p ${dataDir} ${runDir} && chmod 700 ${dataDir} ${runDir} && chown -R ${String(runAsUser)}:${String(runAsUser)} ${dataDir} ${runDir}`,
        ],
        volumeMounts: [
            { name: torDataVolumeName, mountPath: dataDir },
            { name: torRunVolumeName, mountPath: runDir },
        ],
    };
}

function createTorContainerSpec({
    appName,
    configMountPath,
    configVolumeName,
    dataDir,
    resources,
    runAsUser,
    runDir,
}: TorSidecarSettings): SidecarSpec {
    return {
        name: torSidecarName,
        image: getTorImage(appName),
        command: ['tor'],
        commandArgs: ['-f', `${configMountPath}/${torConfigFileName}`],
        volumeMounts: [
            { name: torDataVolumeName, mountPath: dataDir },
            { name: torRunVolumeName, mountPath: runDir },
            {
                name: configVolumeName,
                mountPath: `${configMountPath}/${torConfigFileName}`,
                readOnly: true,
                subPath: torConfigFileName,
            },
        ],
        resources,
        runAsUser,
        runAsGroup: runAsUser,
    };
}

/**
 * A client-only Tor daemon that runs beside an application. It provides a
 * SOCKS proxy and/or a control port on localhost; it never listens on a public
 * address. Onion services are created by the app through the control port, so
 * the onion key stays in the app's own data directory.
 */
export function createTorSidecar(args: TorSidecarArgs): TorSidecar {
    const settings = resolveTorSidecarSettings(args);

    return {
        sidecar: createTorContainerSpec(settings),
        torrc: createTorrc(settings),
        volumes: [
            { name: torDataVolumeName, sizeLimit: '128Mi' },
            { name: torRunVolumeName, memory: true, sizeLimit: '8Mi' },
        ],
        initContainers: [createTorInitContainer(settings)],
        mainVolumeMounts: settings.control
            ? [{ name: torRunVolumeName, mountPath: settings.runDir }]
            : [],
    };
}
