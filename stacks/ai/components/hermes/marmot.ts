import { config, InitContainerSpec, SidecarSpec, toHexPubkey } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The launch profile, whose connector home predates per-profile connectors. */
export const DEFAULT_PROFILE = 'default';

/**
 * The marmot gateway compares raw hex, so a config list becomes:
 *   " npub1abc… , , npub1def… ,"  ->  "<hex>,<hex>"
 */
function accountIdList(appName: string, key: string): string | undefined {
    return config
        .getCommaSeparated(appName, key)
        ?.map(entry => toHexPubkey(entry, `${appName}:${key}`))
        .join(',');
}

export interface MarmotArgs {
    /** Hermes app name; the `marmot/*` config keys are read from it. */
    appName: string;
    /** Hermes profile this connector serves; every profile gets its own. */
    profile: string;
    dataPath: string;
    image: pulumi.Input<string>;
    runtimeUserId: number;
}

/**
 * White Noise (Marmot/Nostr) connector. It runs as a sidecar beside the gateway
 * instead of inside it, so a gateway crash or OOM leaves the relay connection
 * alone. The binary is installed into the data volume, so a fresh volume needs
 * no manual step.
 *
 * The socket path must stay in step with `platforms.marmot` in config.yaml, and
 * inbound media is handed over through a shared emptyDir.
 */
export class Marmot {
    /** Connector home; must stay in step with `platforms.marmot` in config.yaml. */
    readonly profile: string;
    readonly home: string;
    readonly socket: string;
    readonly bin: string;
    /** Sidecar and volume names a profile other than the launch one can own. */
    readonly sidecarName: string;
    readonly mediaVolume: string;
    /** Where the connector keeps decrypted media, shared with the gateway. */
    readonly mediaPath: string;

    constructor(private readonly args: MarmotArgs) {
        this.profile = args.profile;
        // The launch profile keeps the app name: its keypair is the one already
        // invited into groups, and renaming the directory would orphan it.
        const dir = args.profile === DEFAULT_PROFILE ? args.appName : args.profile;
        this.home = `${args.dataPath}/marmot-agents/${dir}`;
        this.socket = `${this.home}/dev/wn-agent.sock`;
        this.bin = `${args.dataPath}/.local/bin/wn-agent`;
        this.sidecarName =
            args.profile === DEFAULT_PROFILE ? 'wn-agent' : `wn-agent-${args.profile}`;
        this.mediaVolume =
            args.profile === DEFAULT_PROFILE
                ? 'marmot-media'
                : `marmot-media-${args.profile}`;
        this.mediaPath =
            args.profile === DEFAULT_PROFILE
                ? '/opt/marmot-media'
                : `/opt/marmot-media/${args.profile}`;
    }

    /**
     * Installs the pinned connector next to `kubectl`, verifying the tarball
     * against the release's published `.sha256`, as upstream documents.
     */
    initContainer(): InitContainerSpec {
        const { dataPath, runtimeUserId } = this.args;
        return {
            name: 'install-wn-agent',
            image: 'alpine:3.24',
            command: [
                'sh',
                '-c',
                readFileSync(join(__dirname, 'init', 'install-wn-agent.sh'), 'utf8'),
            ],
            env: {
                DATA_PATH: dataPath,
                USER_ID: String(runtimeUserId),
                WN_AGENT_VERSION: config.require(this.args.appName, 'marmot/version'),
            },
            volumeMounts: [{ mountPath: dataPath }],
        };
    }

    /** The connector itself, running as the runtime user beside the gateway. */
    sidecar(): SidecarSpec {
        const { dataPath, image, runtimeUserId } = this.args;
        return {
            command: ['/bin/sh', '-c'],
            commandArgs: [
                readFileSync(join(__dirname, 'init', 'run-wn-agent.sh'), 'utf8'),
            ],
            env: {
                HOME: dataPath,
                MARMOT_HOME: this.home,
                MARMOT_SOCKET: this.socket,
                PLUGIN_PATH: `${dataPath}/plugins`,
                PROFILE_NAME: config.get(this.args.appName, 'marmot/profile/name'),
                PROFILE_PICTURE: config.get(this.args.appName, 'marmot/profile/picture'),
                TMPDIR: this.mediaPath,
                WN_AGENT_BIN: this.bin,
            },
            healthCheck: {
                exec: {
                    command: [
                        '/opt/hermes/.venv/bin/python3',
                        '-c',
                        [
                            'import socket',
                            's = socket.socket(socket.AF_UNIX)',
                            's.settimeout(2)',
                            `s.connect('${this.socket}')`,
                        ].join(';'),
                    ],
                },
            },
            image,
            name: this.sidecarName,
            resources: {
                limits: { cpu: '250m', memory: '384Mi' },
                requests: { cpu: '25m', memory: '64Mi' },
            },
            runAsGroup: runtimeUserId,
            runAsUser: runtimeUserId,
            volumeMounts: [
                { mountPath: dataPath },
                { name: this.mediaVolume, mountPath: this.mediaPath },
            ],
        };
    }

    /**
     * The `platforms.marmot` block this profile's config needs: its own socket
     * and media roots, so two profiles never share one relay connection.
     */
    configBlock(): Record<string, unknown> {
        return {
            enabled: true,
            extra: {
                home: this.home,
                // Outbound files (TTS audio, documents) are refused unless their
                // directory is listed here.
                media_local_roots: [
                    `${this.args.dataPath}/audio_cache`,
                    `${this.args.dataPath}/cache/documents`,
                    `${this.home}/dev/inbound-media`,
                ],
                socket_path: this.socket,
            },
        };
    }

    /** Allowlists and the home channel, read by the gateway from its own env. */
    gatewayEnv(): Record<string, pulumi.Input<string> | undefined> {
        const appName = this.args.appName;
        return {
            MARMOT_ALLOW_ALL_USERS: String(
                config.requireBoolean(appName, 'marmot/allowAllUsers'),
            ),
            MARMOT_ALLOWED_USERS: accountIdList(appName, 'marmot/allowedUsers'),
            MARMOT_HOME_CHANNEL: config.get(appName, 'marmot/homeChannel'),
            MARMOT_WELCOMER_ALLOWLIST: accountIdList(appName, 'marmot/welcomerAllowlist'),
        };
    }

    /**
     * The gateway env as a `.env` file. A `.env` line wins over the pod env at
     * load, so seeding the same values replaces whatever a hand edit left on the
     * volume instead of silently losing to it.
     */
    seedEnv(): pulumi.Input<string> {
        return pulumi
            .all(
                Object.entries(this.gatewayEnv()).map(([key, value]) =>
                    pulumi.output(value).apply(v => (v ? `${key}=${v}\n` : '')),
                ),
            )
            .apply(lines => lines.join(''));
    }
}
