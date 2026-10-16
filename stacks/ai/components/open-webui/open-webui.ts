import { Application, config, OidcAuthConfig, requireOutput } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

export interface OpenWebUIArgs {
    ollamaUrl?: string;
    openAiUrl?: string;
    automatic1111Url?: pulumi.Input<string>;
}

export class OpenWebUI extends pulumi.ComponentResource {
    public readonly secretKey: pulumi.Output<string>;
    public readonly app: Application;

    constructor(
        private readonly name: string,
        private readonly args: OpenWebUIArgs,
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:ai:OpenWebUI', name, args, opts);

        this.app = new Application(this, name).addStorage();
        this.secretKey = config.requireSecret(name, 'WEBUI_SECRET_KEY');

        if (this.app.storageOnly) return;

        const httpEndpointInfo = this.app.network.getHttpEndpointInfo();
        const isTailscale = httpEndpointInfo.className === 'tailscale';

        const auth = this.app.auth.getOidc();
        const openAi = this.getOpenAiConnections();
        const env = this.getEnvironment(
            httpEndpointInfo.url,
            isTailscale,
            auth,
            openAi.baseUrls,
            openAi.apiConfigs,
        );

        this.app.addDeployment({
            ports: [{ name: 'http', port: 8080 }],
            volumeMounts: [{ mountPath: '/app/backend/data' }],
            env,
            envSecret: {
                OAUTH_CLIENT_SECRET: auth?.clientSecret,
                OPENAI_API_KEYS: openAi.apiKeys,
                WEBUI_SECRET_KEY: this.secretKey,
            },
            healthCheck: { httpGet: { path: '/health' } },
        });
    }

    /**
     * OpenAI-compatible backends, index-aligned and semicolon-joined as Open WebUI expects.
     * The optional Responses-API connection comes first so it claims its model IDs before the
     * external Chat Completions connection lists the same names (Open WebUI merge is first-wins).
     */
    private getOpenAiConnections(): {
        baseUrls?: pulumi.Output<string>;
        apiKeys?: pulumi.Output<string>;
        apiConfigs?: string;
    } {
        const baseUrls: pulumi.Input<string>[] = [];
        const apiKeys: pulumi.Input<string>[] = [];
        const apiConfigs: Record<string, object> = {};

        const externalBaseUrl = config.get(this.name, 'openai/baseUrl');
        const externalApiKey = externalBaseUrl
            ? config.requireSecret(this.name, 'openai/apiKey')
            : undefined;

        const responsesModels = config.getCommaSeparated(this.name, 'openai/responsesModels');
        if (responsesModels) {
            if (!externalBaseUrl || !externalApiKey) {
                throw new Error(
                    'Open WebUI: open-webui:openai/responsesModels is set but open-webui:openai/baseUrl is not.',
                );
            }
            apiConfigs[baseUrls.length.toString()] = {
                api_type: 'responses',
                model_ids: responsesModels,
            };
            baseUrls.push(externalBaseUrl);
            apiKeys.push(externalApiKey);
        }

        if (this.args.openAiUrl) {
            baseUrls.push(this.args.openAiUrl);
            apiKeys.push('not-used');
        }

        if (externalBaseUrl && externalApiKey) {
            baseUrls.push(externalBaseUrl);
            apiKeys.push(externalApiKey);
        }

        return {
            baseUrls: baseUrls.length
                ? pulumi.all(baseUrls).apply(urls => urls.join(';'))
                : undefined,
            apiKeys: apiKeys.length
                ? pulumi.all(apiKeys).apply(keys => keys.join(';'))
                : undefined,
            apiConfigs: Object.keys(apiConfigs).length
                ? JSON.stringify(apiConfigs)
                : undefined,
        };
    }

    private getEnvironment(
        endpointUrl: pulumi.Input<string>,
        isTailscale: boolean,
        auth: OidcAuthConfig | undefined,
        openAiBaseUrls: pulumi.Input<string> | undefined,
        openAiApiConfigs: string | undefined,
    ): Record<string, pulumi.Input<string> | undefined> {
        const env: Record<string, pulumi.Input<string> | undefined> = {
            AUTOMATIC1111_BASE_URL: this.args.automatic1111Url,
            BYPASS_MODEL_ACCESS_CONTROL: 'True',
            DEFAULT_MODELS: config.get(this.name, 'DEFAULT_MODELS') ?? '',
            DEFAULT_USER_ROLE: config.require(this.name, 'DEFAULT_USER_ROLE'),
            ENABLE_ADMIN_CHAT_ACCESS: 'False',
            ENABLE_EVALUATION_ARENA_MODELS: 'False',
            ENABLE_IMAGE_GENERATION: this.args.automatic1111Url ? 'True' : 'False',
            ENABLE_LOGIN_FORM: isTailscale || auth ? 'False' : 'True',
            ENABLE_PASSWORD_AUTH: auth ? 'False' : 'True',
            ENABLE_PERSISTENT_CONFIG: config.requireBoolean(
                this.name,
                'ENABLE_PERSISTENT_CONFIG',
            )
                ? 'True'
                : 'False',
            ENABLE_SEARCH_QUERY_GENERATION: 'True',
            ENABLE_SIGNUP: auth ? 'False' : 'True',
            ENABLE_VERSION_UPDATE_CHECK: 'False',
            ENABLE_WEB_SEARCH: 'True',
            IMAGE_GENERATION_ENGINE: 'automatic1111',
            LOG_LEVEL: this.app.debug ? 'debug' : undefined,
            OLLAMA_BASE_URLS: this.args.ollamaUrl,
            OPENAI_API_BASE_URLS: openAiBaseUrls,
            OPENAI_API_CONFIGS: openAiApiConfigs,
            USER_PERMISSIONS_FEATURES_DIRECT_TOOL_SERVERS: 'True',
            USER_PERMISSIONS_WORKSPACE_KNOWLEDGE_ACCESS: 'True',
            USER_PERMISSIONS_WORKSPACE_MODELS_ACCESS: 'True',
            USER_PERMISSIONS_WORKSPACE_PROMPTS_ACCESS: 'True',
            USER_PERMISSIONS_WORKSPACE_TOOLS_ACCESS: 'True',
            USE_CUDA_DOCKER: this.app.nodes.getGpu() === 'nvidia' ? 'True' : 'False',
            USE_OLLAMA_DOCKER: 'False',
            WEBUI_AUTH: isTailscale ? 'False' : 'True',
            WEBUI_URL: endpointUrl,
            WEB_SEARCH_ENGINE: 'duckduckgo',
        };

        if (isTailscale) this.addTailscaleEnvironment(env);
        if (auth) this.addOidcEnvironment(env, auth, endpointUrl);

        return env;
    }

    private addTailscaleEnvironment(env: Record<string, pulumi.Input<string> | undefined>): void {
        env.WEBUI_AUTH_TRUSTED_EMAIL_HEADER = 'Tailscale-User-Login';
        env.WEBUI_AUTH_TRUSTED_NAME_HEADER = 'Tailscale-User-Name';
    }

    private addOidcEnvironment(
        env: Record<string, pulumi.Input<string> | undefined>,
        auth: OidcAuthConfig,
        endpointUrl: pulumi.Input<string>,
    ): void {
        env.ENABLE_OAUTH_SIGNUP = 'True';
        env.OAUTH_AUTO_REDIRECT = 'True';
        env.OAUTH_CLIENT_ID = auth.clientId;
        env.OAUTH_MERGE_ACCOUNTS_BY_EMAIL = 'True';
        env.OAUTH_PROVIDER_NAME = auth.providerName ?? 'SSO';
        env.OAUTH_UPDATE_EMAIL_ON_LOGIN = 'True';
        env.OAUTH_UPDATE_NAME_ON_LOGIN = 'True';
        env.OAUTH_UPDATE_PICTURE_ON_LOGIN = 'True';
        env.OPENID_PROVIDER_URL = requireOutput(
            auth.providerUrl,
            'Open WebUI: OIDC enabled (open-webui:auth) but the OIDC provider URL is unavailable. Set orangelab:coreStackRef to a deployed core stack with the auth provider enabled, then deploy this stack.',
        );
        env.WEBUI_AUTH_SIGNOUT_REDIRECT_URL = endpointUrl;
    }
}
