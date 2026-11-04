import { Application, config, createPassword, requireOutput } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stringify } from 'yaml';
import { ClusterAccess } from './cluster-access';
import { HermesInit } from './hermes-init';
import { Marmot } from './marmot';

const dataPath = '/opt/data';
const seedPath = '/opt/hermes-seed';
const runtimeUserId = 10000;

export interface HermesArgs {
    /** Virtual key for the `hermes` agentgateway client. */
    agentgatewayApiKey?: pulumi.Input<string>;
    /** In-cluster OpenAI-compatible endpoint of agentgateway. */
    agentgatewayUrl?: pulumi.Input<string>;
}

export class Hermes extends pulumi.ComponentResource {
    public readonly app: Application;
    /** Dashboard password, set when the bundled username/password provider is used. */
    public readonly dashboardPassword?: pulumi.Output<string>;
    /** Session-signing secret; generated once so the env secret cannot drift. */
    private readonly sessionSecret?: pulumi.Output<string>;

    constructor(
        private readonly name: string,
        private readonly args: HermesArgs = {},
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:ai:Hermes', name, args, opts);

        this.app = new Application(this, name, {
            oidc: { publicClient: true },
        }).addStorage();
        if (this.app.storageOnly) return;

        const githubToken = config.getSecret(name, 'GITHUB_TOKEN');
        const forgejoToken = config.getSecret(name, 'FORGEJO_TOKEN');
        const marmot = this.getMarmot();
        const init = this.getInit();
        const clusterAccess = new ClusterAccess(
            name,
            { namespace: this.app.metadata.namespace },
            { parent: this },
        );
        this.sessionSecret = this.app.oidc ? undefined : this.getSessionSecret();
        this.dashboardPassword = this.app.oidc ? undefined : this.getDashboardPassword();

        this.app.addConfigVolume({
            files: {
                'SOUL.md': loadSoul(config.require(name, 'soulFile')),
                'config.yaml': this.getConfigYaml(marmot),
                kubeconfig: clusterAccess.kubeconfig,
            },
            secretFiles: {
                ...(githubToken
                    ? {
                          'github.env': pulumi.interpolate`GITHUB_TOKEN=${githubToken}\n`,
                      }
                    : {}),
                ...(forgejoToken
                    ? {
                          'forgejo.env': pulumi.interpolate`FORGEJO_TOKEN=${forgejoToken}\n`,
                      }
                    : {}),
            },
        });
        if (marmot) this.app.addEmptyVolume({ name: 'marmot-media' });

        this.createDeployment({ clusterAccess, githubToken, init, marmot });
    }

    private getMarmot(): Marmot | undefined {
        return config.requireBoolean(this.name, 'marmot/enabled')
            ? new Marmot({
                  appName: this.name,
                  dataPath,
                  image: config.require(this.name, 'image'),
                  runtimeUserId,
              })
            : undefined;
    }

    private getInit(): HermesInit {
        return new HermesInit({
            dataPath,
            ghVersion: config.require(this.name, 'ghVersion'),
            kubectlVersion: config.require(this.name, 'kubectlVersion'),
            recreateConfig: config.requireBoolean(this.name, 'recreateConfig'),
            runtimeUserId,
            seedPath,
        });
    }

    private createDeployment(args: {
        clusterAccess: ClusterAccess;
        githubToken?: pulumi.Output<string>;
        init: HermesInit;
        marmot?: Marmot;
    }) {
        // `gateway run` keeps the default profile's gateway alive under s6; the
        // dashboard is a supervised service alongside it and manages every profile.
        this.app.addDeployment({
            commandArgs: ['gateway', 'run'],
            env: this.getEnv({
                gitCredentialHelper: args.githubToken !== undefined,
                marmot: args.marmot,
            }),
            envSecret: this.getEnvSecret(),
            healthCheck: { httpGet: { path: '/api/status' } },
            initContainers: [
                args.init.seed(),
                args.init.kubectl(),
                args.init.gh(),
                ...(args.marmot ? [args.marmot.initContainer()] : []),
            ],
            ports: [{ name: 'http', port: 9119 }],
            resources: {
                requests: { cpu: '100m', memory: '1Gi' },
                // Model loads (faster-whisper, Chromium) spike well past the
                // idle ~750Mi; 3Gi OOM-killed the gateway during an STT load.
                limits: { cpu: '2', memory: '6Gi' },
            },
            serviceAccountName: args.clusterAccess.serviceAccount.metadata.name,
            sidecars: args.marmot ? [args.marmot.sidecar()] : undefined,
            volumeMounts: [
                { mountPath: dataPath },
                { name: 'config', mountPath: seedPath, readOnly: true },
                // The connector decrypts inbound media under its TMPDIR, so the
                // gateway must see the same emptyDir to pick the files up.
                ...(args.marmot
                    ? [{ name: 'marmot-media', mountPath: '/opt/marmot-media' }]
                    : []),
            ],
            volumeOwnerUserId: runtimeUserId,
        });
    }

    private getEnv(args: {
        /** Only the helper name is set here; the token itself lives in .env. */
        gitCredentialHelper: boolean;
        marmot?: Marmot;
    }): Record<string, pulumi.Input<string> | undefined> {
        return {
            ...(args.gitCredentialHelper
                ? {
                      GIT_CONFIG_COUNT: '1',
                      GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
                      GIT_CONFIG_VALUE_0: '!gh auth git-credential',
                  }
                : {}),
            HERMES_DASHBOARD: '1',
            HERMES_DASHBOARD_BASIC_AUTH_USERNAME: this.app.oidc ? undefined : 'admin',
            HERMES_DASHBOARD_OIDC_CLIENT_ID: this.app.oidc?.clientId,
            HERMES_DASHBOARD_OIDC_ISSUER: this.app.oidc
                ? this.getOidcIssuer()
                : undefined,
            HERMES_DASHBOARD_PUBLIC_URL: this.app.network.getHttpEndpointInfo().url,
            KUBECONFIG: `${seedPath}/kubeconfig`,
            ...(args.marmot ? args.marmot.gatewayEnv() : {}),
        };
    }

    private getEnvSecret(): Record<string, pulumi.Input<string> | undefined> {
        return {
            HERMES_DASHBOARD_BASIC_AUTH_PASSWORD: this.app.oidc
                ? undefined
                : this.dashboardPassword,
            HERMES_DASHBOARD_BASIC_AUTH_SECRET: this.sessionSecret,
            OPENAI_API_KEY: this.getAgentgatewayApiKey(),
        };
    }

    private getDashboardPassword(): pulumi.Output<string> {
        return (
            config.getSecret(this.name, 'dashboard/password') ??
            createPassword(this, `${this.name}-dashboard-password`, { length: 24 })
        );
    }

    private getSessionSecret(): pulumi.Output<string> {
        return createPassword(this, `${this.name}-dashboard-session-secret`, {
            length: 48,
        });
    }

    private getOidcIssuer(): pulumi.Input<string> {
        return requireOutput(
            this.app.oidc?.providerBaseUrl,
            `${this.name}:auth pocket needs orangelab:coreStackRef pointing at a core stack with Pocket ID enabled.`,
        );
    }

    private getAgentgatewayApiKey(): pulumi.Input<string> | undefined {
        if (!config.get(this.name, 'model')) return undefined;
        return requireOutput(
            this.args.agentgatewayApiKey,
            `${this.name}:model needs agentgateway:enabled and 'hermes' in agentgateway:clients.`,
        );
    }

    private getAgentgatewayUrl(): pulumi.Input<string> {
        return requireOutput(
            this.args.agentgatewayUrl,
            `${this.name}:model needs agentgateway:enabled and 'hermes' in agentgateway:clients.`,
        );
    }

    /**
     * Seeded once, then owned by the dashboard. `recreateConfig` restores the
     * model and trusted-proxy settings, discarding dashboard edits.
     */
    private getConfigYaml(marmot?: Marmot): pulumi.Input<string> {
        const settings: Record<string, unknown> = {
            dashboard: {
                trusted_proxies: config.requireCommaSeparated(
                    this.name,
                    'trustedProxies',
                ),
            },
            gateway: { multiplex_profiles: true },
            terminal: { backend: 'local', cwd: `${dataPath}/workspace` },
        };
        if (marmot) {
            settings.platforms = {
                marmot: {
                    enabled: true,
                    extra: { home: marmot.home, socket_path: marmot.socket },
                },
            };
            // The CLI (hermes send, cron delivery) only registers enabled plugins.
            settings.plugins = { enabled: ['marmot'] };
        }
        const model = config.get(this.name, 'model');
        if (!model) return stringify(settings);

        return pulumi.output(this.getAgentgatewayUrl()).apply(baseUrl =>
            stringify({
                ...settings,
                model: {
                    api_mode: 'chat_completions',
                    base_url: baseUrl,
                    default: model,
                    key_env: 'OPENAI_API_KEY',
                    provider: 'custom',
                },
            }),
        );
    }
}

/** Resolves against the stack directory, where `pulumi up` runs. */
function loadSoul(path: string): string {
    const file = resolve(path);
    try {
        return readFileSync(file, 'utf8');
    } catch (error) {
        throw new Error(`Cannot read Hermes SOUL.md at '${file}': ${String(error)}`, {
            cause: error,
        });
    }
}
