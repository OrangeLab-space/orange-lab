import {
    Application,
    config,
    createPassword,
    InitContainerSpec,
    requireOutput,
    ServicePort,
} from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stringify } from 'yaml';
import { ClusterAccess } from './cluster-access';
import { HermesInit } from './hermes-init';
import { DEFAULT_PROFILE, Marmot } from './marmot';

const dataPath = '/opt/data';
const seedPath = '/opt/hermes-seed';
const runtimeUserId = 10000;
/** OpenAI-compatible API for in-cluster clients; kept off the app's public hostname. */
const apiServerPort = 8642;
/** HMAC-signed event listener for scripts and forges; cluster-only like the API port. */
const webhookPort = 8644;
/** The one route seeded into the deployments: Forgejo pull request comments. */
const webhookRoute = 'forgejo-pr';

export interface SpeechSettings {
    /** OpenAI-compatible speech endpoint, including the `/v1` suffix. */
    url: pulumi.Input<string>;
    sttModel: string;
    ttsModel: string;
    ttsVoice: string;
}

export interface HermesArgs {
    /** Virtual key for the `hermes` agentgateway client. */
    agentgatewayApiKey?: pulumi.Input<string>;
    /** In-cluster OpenAI-compatible endpoint of agentgateway. */
    agentgatewayUrl?: pulumi.Input<string>;
    /**
     * Key the OpenAI-compatible API server requires, minted by agentgateway. The
     * server and its port exist only when this is set: every caller is one the
     * gateway authenticated, and a keyless listener is the one shape the agent's
     * own startup audit warns about.
     */
    apiServerKey?: pulumi.Input<string>;
    /**
     * Keys for the profiles served over the same listener as `/p/<profile>/v1`,
     * keyed by profile name. A profile reads its own `.env` only, so it cannot
     * authenticate with the default profile's key.
     */
    apiServerProfileKeys?: Record<string, pulumi.Input<string>>;
    /**
     * Extra Hermes profiles. Each one gets its own connector — separate home,
     * socket and keypair — so a profile talks to the relay as its own agent
     * instead of borrowing the launch profile's identity.
     */
    profiles?: string[];
    /** Speech-to-text and text-to-speech models, from the `speaches` component. */
    speech?: SpeechSettings;
}

export class Hermes extends pulumi.ComponentResource {
    public readonly app: Application;
    /** In-cluster endpoint of the API server, empty while that server is disabled. */
    public readonly apiUrl: pulumi.Output<string>;
    /** Key the API server requires, absent while that server is disabled. */
    public readonly apiServerKey?: pulumi.Input<string>;
    /** Dashboard password, set when the bundled username/password provider is used. */
    public readonly dashboardPassword?: pulumi.Output<string>;
    /** Session-signing secret; generated once so the env secret cannot drift. */
    private readonly sessionSecret?: pulumi.Output<string>;
    /** Shared HMAC secret for the webhook listener; every route falls back to it. */
    public readonly webhookSecret?: pulumi.Output<string>;

    constructor(
        private readonly name: string,
        private readonly args: HermesArgs = {},
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:ai:Hermes', name, args, opts);

        this.app = new Application(this, name, {
            oidc: { publicClient: true },
        }).addStorage();
        this.apiServerKey = args.apiServerKey;
        if (this.app.storageOnly) {
            this.apiUrl = pulumi.output('');
            return;
        }

        const githubToken = config.getSecret(name, 'GITHUB_TOKEN');
        const forgejoToken = config.getSecret(name, 'FORGEJO_TOKEN');
        const marmots = this.getMarmots();
        const marmot = marmots.length > 0 ? marmots[0] : undefined;
        const init = this.getInit();
        const clusterAccess = new ClusterAccess(
            name,
            { namespace: this.app.metadata.namespace },
            { parent: this },
        );
        this.sessionSecret = this.app.oidc ? undefined : this.getSessionSecret();
        this.dashboardPassword = this.app.oidc ? undefined : this.getDashboardPassword();
        this.webhookSecret =
            config.getSecret(name, 'webhook/secret') ??
            createPassword(this, `${this.name}-webhook-secret`, { length: 48 });

        this.app.addConfigVolume({
            files: {
                'SOUL.md': loadSoul(config.require(name, 'soulFile')),
                'config.yaml': this.getConfigYaml(marmot),
                kubeconfig: clusterAccess.kubeconfig,
                // Seeded so the exported URL answers on the first deploy; the
                // route carries no secret of its own and falls back to
                // WEBHOOK_SECRET, which keeps the value out of this ConfigMap.
                'webhook_subscriptions.json': this.getWebhookSubscriptions(marmot),
                'forgejo-pr.py': readFileSync(
                    resolve(__dirname, 'init', 'forgejo-pr.py'),
                    'utf8',
                ),
                // Same reason as the API server key: `.env` beats the pod env,
                // so a hand-edited senders or welcomer list there would otherwise
                // override the configured one and read as a broken allowlist.
                ...(marmot ? { 'marmot.env': marmot.seedEnv() } : {}),
                ...(marmots.length > 1
                    ? {
                          // The init container writes these into each profile's
                          // own config.yaml; the launch profile is already in the
                          // config.yaml above.
                          'marmot-profiles.txt': marmots
                              .slice(1)
                              .map(m => `${m.profile} ${m.home} ${m.socket}`)
                              .join('\n')
                              .concat('\n'),
                      }
                    : {}),
            },
            secretFiles: {
                ...(this.apiServerKey
                    ? {
                          // Hermes enables its OpenAI-compatible listener from a
                          // usable API_SERVER_KEY, and a key in `.env` beats the pod
                          // env, so the seeded value also replaces any stale one a
                          // hand edit left on the volume.
                          'api-server.env': pulumi.interpolate`API_SERVER_KEY=${this.apiServerKey}\n`,
                      }
                    : {}),
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
                ...this.getProfileKeyFiles(),
            },
        });
        for (const marmot of marmots)
            this.app.addEmptyVolume({ name: marmot.mediaVolume });

        this.createDeployment({ clusterAccess, githubToken, init, marmots });

        // The API port is exported for in-cluster clients only (agentgateway's
        // `hermes` provider); it never joins the dashboard's public hostname.
        this.apiUrl = this.apiServerEnabled
            ? pulumi.interpolate`http://${this.name}.${this.app.metadata.namespace}:${String(apiServerPort)}/v1`
            : pulumi.output('');
        if (this.apiServerEnabled) {
            this.app.network.addClusterEndpoint(`${this.name}-api`, this.apiUrl);
        }
        // The full route URL, not the base: a sender pastes one value into its
        // webhook settings, and this is the one the seeded route answers on.
        this.app.network.addClusterEndpoint(
            `${this.name}-webhook`,
            pulumi.interpolate`http://${this.name}.${this.app.metadata.namespace}:${String(webhookPort)}/webhooks/${webhookRoute}`,
        );
    }

    private get apiServerEnabled(): boolean {
        return this.apiServerKey !== undefined;
    }

    /** The launch profile's connector first, then one per configured profile. */
    private getMarmots(): Marmot[] {
        if (!config.requireBoolean(this.name, 'marmot/enabled')) return [];
        const image = config.require(this.name, 'image');
        return [DEFAULT_PROFILE, ...(this.args.profiles ?? [])].map(
            profile =>
                new Marmot({
                    appName: this.name,
                    dataPath,
                    image,
                    profile,
                    runtimeUserId,
                }),
        );
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
        marmots: Marmot[];
    }) {
        // `gateway run` keeps the default profile's gateway alive under s6; the
        // dashboard is a supervised service alongside it and manages every profile.
        const ports: ServicePort[] = [
            { name: 'http', port: 9119 },
            // Cluster-only: the Service carries it, no route or load balancer.
            // The listener keeps its default bind (all interfaces) so the
            // Service can reach it.
            { exposure: 'internal', name: 'webhook', port: webhookPort },
        ];
        // The API port only exists when a key was handed in, so a stack without
        // agentgateway keeps a single port as before.
        if (this.apiServerEnabled) {
            ports.push({ exposure: 'internal', name: 'api', port: apiServerPort });
        }
        this.app.addDeployment({
            commandArgs: ['gateway', 'run'],
            env: this.getEnv({
                gitCredentialHelper: args.githubToken !== undefined,
                marmot: args.marmots[0],
            }),
            envSecret: this.getEnvSecret(),
            healthCheck: { httpGet: { path: '/api/status' } },
            initContainers: [
                args.init.seed(),
                args.init.kubectl(),
                args.init.gh(),
                // One install serves every profile: the binary is shared.
                ...(args.marmots.length > 0 ? [args.marmots[0].initContainer()] : []),
                ...this.getProfileSeedingInit(args.marmots),
            ],
            ports,
            resources: {
                requests: { cpu: '100m', memory: '1Gi' },
                // Model loads (faster-whisper, Chromium) spike well past the
                // idle ~750Mi; 3Gi OOM-killed the gateway during an STT load.
                limits: { cpu: '2', memory: '6Gi' },
            },
            serviceAccountName: args.clusterAccess.serviceAccount.metadata.name,
            sidecars:
                args.marmots.length > 0
                    ? args.marmots.map(marmot => marmot.sidecar())
                    : undefined,
            volumeMounts: [
                { mountPath: dataPath },
                { name: 'config', mountPath: seedPath, readOnly: true },
                // The connector decrypts inbound media under its TMPDIR, so the
                // gateway must see the same emptyDir to pick the files up.
                ...args.marmots.map(marmot => ({
                    name: marmot.mediaVolume,
                    mountPath: marmot.mediaPath,
                })),
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
            ...(this.apiServerEnabled
                ? {
                      // The listener switches on from a usable API_SERVER_KEY in
                      // `.env`; API_SERVER_ENABLED is documentation-only upstream.
                      API_SERVER_HOST: '0.0.0.0',
                      // No API_SERVER_MODEL_NAME: the advertised id is derived per
                      // route — the profile name, `hermes-agent` for the default
                      // profile — so list that under `agentgateway:providers.hermes`.
                      // models, and each /p/<profile>/ prefix advertises its own.
                      API_SERVER_PORT: String(apiServerPort),
                  }
                : {}),
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
            // The listener reads these two from the process env; the secret beside
            // them comes from getEnvSecret so it never lands in a ConfigMap.
            WEBHOOK_ENABLED: 'true',
            WEBHOOK_PORT: String(webhookPort),
            // The allowlists are read from the process env, so every profile
            // shares them; profile isolation comes from the connector identity,
            // not from this gate.
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
            // One secret for the listener and for every route that does not set
            // its own: the sender signs with this value, so it must not rotate
            // per route.
            WEBHOOK_SECRET: this.webhookSecret,
        };
    }

    /**
     * Seeds the route the exported `hermes-webhook` endpoint answers on.
     *
     * Forgejo sends GitHub-compatible headers (`X-GitHub-Event`,
     * `X-Hub-Signature-256: sha256=…`), which is exactly what Hermes validates,
     * so no adapter sits between the hook and the route.
     *
     * The route names no secret on purpose: Hermes falls back to the global
     * `WEBHOOK_SECRET`, so the value never reaches this ConfigMap and the hook
     * only ever needs one value on both ends.
     */
    private getWebhookSubscriptions(marmot?: Marmot): string {
        const homeChannel = config.get(this.name, 'marmot/homeChannel');
        const deliverToChat = marmot !== undefined && homeChannel !== undefined;
        return JSON.stringify(
            {
                [webhookRoute]: {
                    description:
                        'Comment or review on a pull request in a Forgejo repository that posts here',
                    events: [
                        'issue_comment',
                        'pull_request_comment',
                        'pull_request_review_comment',
                        'pull_request_review_approved',
                        'pull_request_review_rejected',
                    ],
                    profile: 'default',
                    // The reply the agent posts fires the same event; without this
                    // the route wakes itself with every answer it writes.
                    filters: [{ field: 'payload.sender.login', not_equals: 'agent' }],
                    script: 'forgejo-pr.py',
                    // A webhook session runs the platform's `hermes-webhook`
                    // toolset — web search and vision, no shell — which cannot
                    // reach the internal git host or push a branch. This route
                    // does the repo workflow, so it gets the tools for it and
                    // nothing that outlives the turn: no cron, skills, memory,
                    // delegation or browser behind an untrusted payload.
                    toolsets: ['terminal', 'file', 'web'],
                    prompt: buildWebhookPrompt(),
                    deliver: deliverToChat ? 'marmot' : 'log',
                    ...(deliverToChat ? { deliver_extra: { chat_id: homeChannel } } : {}),
                },
            },
            null,
            2,
        );
    }

    /**
     * A profile reads only its own `config.yaml`, so its connector block has to
     * land there. `hermes config set` is the writer because that file carries
     * keys this component does not own, and the CLI merges instead of replacing.
     */
    private getProfileSeedingInit(marmots: Marmot[]): InitContainerSpec[] {
        if (marmots.length < 2) return [];
        return [
            {
                name: 'seed-marmot-profiles',
                image: config.require(this.name, 'image'),
                command: [
                    'sh',
                    '-c',
                    readFileSync(
                        resolve(__dirname, 'init', 'seed-marmot-profiles.sh'),
                        'utf8',
                    ),
                ],
                env: {
                    DATA_PATH: dataPath,
                    HERMES_BIN: '/opt/hermes/.venv/bin/hermes',
                    HERMES_HOME: dataPath,
                    PLUGINS: config.requireCommaSeparated(this.name, 'plugins').join(','),
                    SEED_PATH: seedPath,
                    // The gateway writes its own config as this user; root-owned
                    // files would lock it out of the profile it just configured.
                    USER_NAME: 'hermes',
                },
                volumeMounts: [
                    { mountPath: dataPath },
                    { name: 'config', mountPath: seedPath, readOnly: true },
                ],
            },
        ];
    }

    /**
     * One seeded file per profile; the init container copies each into that
     * profile's `.env`, which is the only place its scope reads a key from.
     */
    private getProfileKeyFiles(): Record<string, pulumi.Input<string>> {
        return Object.fromEntries(
            Object.entries(this.args.apiServerProfileKeys ?? {}).map(([profile, key]) => [
                `api-server-${profile}.env`,
                pulumi.interpolate`API_SERVER_KEY=${key}\n`,
            ]),
        );
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
        // The listener starts from WEBHOOK_ENABLED in the pod env, but the CLI and
        // the dashboard gate on this key: without it `hermes webhook` answers
        // "Webhook platform is not enabled" beside a listener that is already up.
        settings.platforms = {
            webhook: { enabled: true, port: webhookPort },
            ...(marmot ? { marmot: marmot.configBlock() } : {}),
        };
        // Hermes loads a plugin only when it is named here; an installed but
        // unlisted adapter answers every route with "Plugin not found".
        settings.plugins = {
            enabled: config.requireCommaSeparated(this.name, 'plugins'),
        };

        const fragments = this.getConfigFragments();
        if (fragments.length === 0) return stringify(settings);
        return pulumi
            .all(fragments)
            .apply(parts => stringify(Object.assign({}, settings, ...parts)));
    }

    /** Settings that depend on another component's endpoint, merged into config.yaml. */
    private getConfigFragments(): pulumi.Input<Record<string, unknown>>[] {
        const fragments: pulumi.Input<Record<string, unknown>>[] = [];
        const model = config.get(this.name, 'model');
        if (model) {
            fragments.push(
                pulumi.output(this.getAgentgatewayUrl()).apply(baseUrl => ({
                    model: {
                        api_mode: 'chat_completions',
                        base_url: baseUrl,
                        default: model,
                        key_env: 'OPENAI_API_KEY',
                        provider: 'custom',
                    },
                })),
            );
        }
        const speech = this.args.speech;
        if (speech) {
            // Without these blocks inbound voice notes arrive untranscribed and
            // replies are text-only; the gateway never learns the models exist.
            fragments.push(
                pulumi.output(speech.url).apply(baseUrl => ({
                    stt: {
                        openai: { base_url: baseUrl, model: speech.sttModel },
                        provider: 'openai',
                    },
                    tts: {
                        openai: {
                            base_url: baseUrl,
                            model: speech.ttsModel,
                            voice: speech.ttsVoice,
                        },
                        provider: 'openai',
                    },
                })),
            );
        }
        return fragments;
    }
}

/**
 * Prompt for the `forgejo-pr` route. Fields come from `init/forgejo-pr.py`,
 * which flattens every comment event into one shape; braces are Hermes template
 * references, so the text carries no literal ones.
 */
function buildWebhookPrompt(): string {
    return [
        'A {kind} landed on {repo}#{number} — {title}',
        '',
        'From: {author}',
        'Thread: {url}',
        '',
        '{body}',
        '',
        'You are the cluster operator agent. Read before you answer:',
        '- Pull the description, the thread and the diff over the API of the',
        '  instance in Thread (token in $FORGEJO_TOKEN).',
        '- If the comment asks for a change, make it on the pull request branch,',
        '  push, and say what you changed and what you verified.',
        '- Reply in the thread: POST /api/v1/repos/{repo}/issues/{number}/comments',
        '  with a JSON body of "body". Never push to a branch the comment did not',
        '  ask about, and never merge.',
        '- End with one or two lines on what you did; that text is what reaches the chat.',
    ].join('\n');
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
