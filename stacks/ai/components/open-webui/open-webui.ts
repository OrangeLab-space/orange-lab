import { Application, config, OidcAuthConfig, requireOutput } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import { ComfyUIModelFile } from '../comfyui/model-file';

export interface SpeechConnection {
    url: pulumi.Input<string>;
    sttModel: string;
    ttsModel: string;
    ttsVoice: string;
}

export interface ImageGenerationConnection {
    /** Model bundle with the ComfyUI workflow, model name and node mapping. */
    model?: ComfyUIModelFile;
    url: pulumi.Input<string>;
}

export interface OpenWebUIArgs {
    agentgatewayUrl?: pulumi.Input<string>;
    agentgatewayApiKey?: pulumi.Input<string>;
    imageGeneration?: ImageGenerationConnection;
    ollamaUrl?: pulumi.Input<string>;
    speech?: SpeechConnection;
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
        const agentgateway = this.getAgentgatewayConnection();
        const env = this.getEnvironment(
            httpEndpointInfo.url,
            isTailscale,
            auth,
            agentgateway?.url,
        );

        this.app.addDeployment({
            ports: [{ name: 'http', port: 8080 }],
            volumeMounts: [{ mountPath: '/app/backend/data' }],
            env,
            envSecret: {
                OAUTH_CLIENT_SECRET: auth?.clientSecret,
                OPENAI_API_KEYS: agentgateway?.apiKey,
                WEBUI_SECRET_KEY: this.secretKey,
            },
            healthCheck: { httpGet: { path: '/health' } },
            resources: {
                requests: { cpu: '100m', memory: '512Mi' },
                limits: { cpu: '1', memory: '1Gi' },
            },
        });
    }

    /**
     * Connect the gateway when it is enabled. Open WebUI discovers its models from
     * /v1/models; model selection and any other backends are configured in the UI.
     */
    private getAgentgatewayConnection():
        | {
              apiKey: pulumi.Input<string>;
              url: pulumi.Input<string>;
          }
        | undefined {
        if (!this.args.agentgatewayUrl) return undefined;
        return {
            apiKey: this.args.agentgatewayApiKey ?? 'not-used',
            url: this.args.agentgatewayUrl,
        };
    }

    private getEnvironment(
        endpointUrl: pulumi.Input<string>,
        isTailscale: boolean,
        auth: OidcAuthConfig | undefined,
        agentgatewayUrl: pulumi.Input<string> | undefined,
    ): Record<string, pulumi.Input<string> | undefined> {
        const speech = this.args.speech;
        const env: Record<string, pulumi.Input<string> | undefined> = {
            ...(speech
                ? {
                      AUDIO_STT_ENGINE: 'openai',
                      AUDIO_STT_MODEL: speech.sttModel,
                      AUDIO_STT_OPENAI_API_BASE_URL: speech.url,
                      AUDIO_STT_OPENAI_API_KEY: 'not-needed',
                      AUDIO_TTS_ENGINE: 'openai',
                      AUDIO_TTS_MODEL: speech.ttsModel,
                      AUDIO_TTS_OPENAI_API_BASE_URL: speech.url,
                      AUDIO_TTS_OPENAI_API_KEY: 'not-needed',
                      AUDIO_TTS_VOICE: speech.ttsVoice,
                  }
                : {}),
            ...this.getImageGenerationEnvironment(),
            BYPASS_MODEL_ACCESS_CONTROL: config.require(
                this.name,
                'BYPASS_MODEL_ACCESS_CONTROL',
            ),
            DEFAULT_MODELS: config.get(this.name, 'DEFAULT_MODELS') ?? '',
            DEFAULT_USER_ROLE: config.require(this.name, 'DEFAULT_USER_ROLE'),
            ENABLE_ADMIN_CHAT_ACCESS: 'False',
            ENABLE_EVALUATION_ARENA_MODELS: 'False',
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
            LOG_LEVEL: this.app.debug ? 'debug' : undefined,
            OLLAMA_BASE_URLS: this.args.ollamaUrl,
            OPENAI_API_BASE_URLS: agentgatewayUrl,
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

    private getImageGenerationEnvironment(): Record<
        string,
        pulumi.Input<string> | undefined
    > {
        const imageGeneration = this.args.imageGeneration;
        if (!imageGeneration) return { ENABLE_IMAGE_GENERATION: 'False' };
        const model = imageGeneration.model;
        if (!model) {
            // Workflow and model are configured in Open WebUI's admin UI.
            return {
                COMFYUI_BASE_URL: imageGeneration.url,
                ENABLE_IMAGE_GENERATION: 'True',
                IMAGE_GENERATION_ENGINE: 'comfyui',
            };
        }
        return {
            COMFYUI_BASE_URL: imageGeneration.url,
            COMFYUI_WORKFLOW: JSON.stringify(model.workflow),
            COMFYUI_WORKFLOW_NODES: JSON.stringify(model.nodes),
            ENABLE_IMAGE_GENERATION: 'True',
            IMAGE_GENERATION_ENGINE: 'comfyui',
            IMAGE_GENERATION_MODEL: model.model,
        };
    }

    private addTailscaleEnvironment(
        env: Record<string, pulumi.Input<string> | undefined>,
    ): void {
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
