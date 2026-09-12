import {
    Application,
    config,
    DatabaseConfig,
    HttpEndpointInfo,
    OidcAuthConfig,
    VolumeMount,
} from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

export class Immich extends pulumi.ComponentResource {
    public readonly app: Application;
    public readonly jwtSecret: pulumi.Output<string>;
    public readonly dbConfig?: DatabaseConfig;

    constructor(
        private name: string,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super('orangelab:media:Immich', name, {}, opts);

        this.app = new Application(this, name).addStorage().addPostgres().addRedis();
        this.jwtSecret = pulumi.output(
            config.get(name, 'JWT_SECRET') ?? this.app.createPassword('jwt-secret'),
        );

        this.dbConfig = this.app.databases?.getConfig();
        if (!this.dbConfig) throw new Error('Database not found');
        const httpEndpointInfo = this.app.network.getHttpEndpointInfo();

        const mlEnabled = config.requireBoolean(this.name, 'machine-learning/enabled');
        if (mlEnabled) {
            this.app.addStorage({ name: 'machine-learning' });
        }
        if (this.app.storageOnly) return;

        const auth = this.app.auth.getOidc();
        const smtpEnabled = config.requireBoolean(this.name, 'smtp/enabled');
        const configFile = this.createConfigFile(auth, mlEnabled, smtpEnabled);
        this.app.addConfigVolume({
            secretFiles: { 'immich.json': configFile },
        });

        this.createDeployment({
            httpEndpointInfo,
            dbConfig: this.dbConfig,
            mlEnabled,
        });
        if (mlEnabled) {
            this.createMlDeployment();
        }
    }

    private createConfigFile(
        auth: OidcAuthConfig | undefined,
        mlEnabled: boolean,
        smtpEnabled: boolean,
    ) {
        return pulumi.jsonStringify({
            machineLearning: this.getMachineLearningConfig(mlEnabled),
            notifications: { smtp: this.getSmtpConfig(smtpEnabled) },
            oauth: this.getOauthConfig(auth),
        });
    }

    private getMachineLearningConfig(enabled: boolean) {
        return {
            enabled,
            ...(enabled ? { urls: ['http://immich-machine-learning:3003'] } : {}),
        };
    }

    private getSmtpConfig(enabled: boolean) {
        if (!enabled) return { enabled: false };

        return {
            enabled: true,
            from: config.require(this.name, 'smtp/from'),
            transport: {
                host: config.require(this.name, 'smtp/host'),
                ignoreCert: false,
                password: config.requireSecret(this.name, 'smtp/password'),
                port: config.requireNumber(this.name, 'smtp/port'),
                secure: config.requireBoolean(this.name, 'smtp/secure'),
                username: config.require(this.name, 'smtp/username'),
            },
        };
    }

    private getOauthConfig(auth: OidcAuthConfig | undefined) {
        if (!auth) return { enabled: false };

        return {
            autoLaunch: true,
            autoRegister: true,
            buttonText: `Login with ${auth.providerName ?? 'SSO'}`,
            clientId: auth.clientId,
            clientSecret: auth.clientSecret,
            enabled: true,
            issuerUrl: pulumi.output(auth.providerUrl).apply(url => {
                if (!url) {
                    throw new Error(
                        'Immich: OIDC enabled (immich:auth) but the OIDC provider URL is unavailable. Set orangelab:coreStackRef to a deployed core stack with the auth provider enabled, or set immich:auth/providerUrl.',
                    );
                }
                return url;
            }),
            scope: 'openid email profile',
            signingAlgorithm: 'RS256',
            tokenEndpointAuthMethod: 'client_secret_post',
        };
    }

    private createDeployment(args: {
        httpEndpointInfo: HttpEndpointInfo;
        dbConfig: DatabaseConfig;
        mlEnabled: boolean;
    }) {
        const waitForDb = this.app.databases?.getWaitContainer();
        const redisConfig = this.app.databases?.getConfig('redis');
        if (!redisConfig) throw new Error('Redis not found');

        const volumeMounts: VolumeMount[] = [
            { mountPath: '/data' },
            { mountPath: '/config', name: 'config', readOnly: true },
        ];
        const env: Record<string, pulumi.Input<string>> = {
            DB_DATABASE_NAME: args.dbConfig.database,
            DB_HOSTNAME: args.dbConfig.hostname,
            DB_PORT: pulumi.interpolate`${args.dbConfig.port}`,
            DB_USERNAME: args.dbConfig.username,
            IMMICH_CONFIG_FILE: '/config/immich.json',
            IMMICH_LOG_LEVEL: this.app.debug ? 'debug' : 'log',
            IMMICH_MACHINE_LEARNING_ENABLED: args.mlEnabled.toString(),
            IMMICH_MACHINE_LEARNING_URL: 'http://immich-machine-learning:3003',
            IMMICH_PORT: '2283',
            IMMICH_TRUSTED_PROXIES: config.require(this.name, 'trustedProxies'),
            REDIS_HOSTNAME: redisConfig.hostname,
        };

        const waitForRedis = this.app.databases?.getWaitContainer(redisConfig);
        return this.app.addDeployment({
            ports: [{ name: 'http', port: 2283 }],
            volumeMounts,
            env,
            envSecret: {
                DB_PASSWORD: args.dbConfig.password,
                JWT_SECRET: this.jwtSecret,
            },
            initContainers: [
                ...(waitForRedis ? [waitForRedis] : []),
                ...(waitForDb ? [waitForDb] : []),
            ],
            resources: {
                requests: { memory: '512Mi' },
                limits: { memory: '2Gi' },
            },
        });
    }

    private createMlDeployment() {
        this.app.addDeployment({
            name: 'machine-learning',
            ports: [{ name: 'http', port: 3003, private: true }],
            volumeMounts: [{ mountPath: '/cache', name: 'machine-learning' }],
            env: {
                IMMICH_LOG_LEVEL: this.app.debug ? 'debug' : 'log',
                IMMICH_PORT: '3003',
            },
            resources: {
                requests: { memory: '512Mi' },
            },
        });
    }

}
