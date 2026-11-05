import { config, InitContainerSpec, SidecarSpec } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MarmotArgs {
    /** Hermes app name; the `marmot/*` config keys are read from it. */
    appName: string;
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
    readonly home: string;
    readonly socket: string;
    readonly bin: string;

    constructor(private readonly args: MarmotArgs) {
        this.home = `${args.dataPath}/marmot-agents/hermes`;
        this.socket = `${this.home}/dev/wn-agent.sock`;
        this.bin = `${args.dataPath}/.local/bin/wn-agent`;
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
            commandArgs: [this.runScript()],
            env: { HOME: dataPath, MARMOT_HOME: this.home, TMPDIR: '/opt/marmot-media' },
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
            name: 'wn-agent',
            resources: {
                limits: { cpu: '250m', memory: '384Mi' },
                requests: { cpu: '25m', memory: '64Mi' },
            },
            runAsGroup: runtimeUserId,
            runAsUser: runtimeUserId,
            volumeMounts: [
                { mountPath: dataPath },
                { name: 'marmot-media', mountPath: '/opt/marmot-media' },
            ],
        };
    }

    /** Allowlists and the home channel, read by the gateway from its own env. */
    gatewayEnv(): Record<string, pulumi.Input<string> | undefined> {
        const appName = this.args.appName;
        return {
            MARMOT_ALLOW_ALL_USERS: String(
                config.requireBoolean(appName, 'marmot/allowAllUsers'),
            ),
            MARMOT_ALLOWED_USERS: config.get(appName, 'marmot/allowedUsers'),
            MARMOT_HOME_CHANNEL: config.get(appName, 'marmot/homeChannel'),
            MARMOT_WELCOMER_ALLOWLIST: config.get(appName, 'marmot/welcomerAllowlist'),
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

    private runScript(): string {
        return [
            'set -eu',
            `sock=${this.socket}`,
            '# A socket left by a dead process blocks bind; the connector is the only writer.',
            'rm -f "$sock"',
            `${this.bin} --version`,
            `exec ${this.bin} \\`,
            '  --home "$MARMOT_HOME" \\',
            '  --socket "$sock" \\',
            '  --media-allowed-root "$MARMOT_HOME/dev/outbound-media" \\',
            '  --relay wss://relay.eu.whitenoise.chat \\',
            '  --relay wss://relay.us.whitenoise.chat',
        ].join('\n');
    }
}
