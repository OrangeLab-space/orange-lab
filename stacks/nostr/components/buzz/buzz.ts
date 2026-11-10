import {
    Application,
    config,
    DatabaseConfig,
    HttpEndpointInfo,
    toHexPubkey,
} from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

/**
 * Buzz relay: a Nostr workspace where humans and agents share rooms.
 *
 * One process serves the websocket data plane, the REST API and the web client.
 * Postgres holds the event log and repo names, Redis backs pub/sub, and S3 holds
 * media and git objects — the mounted volume is only a hydration cache, so it is
 * disposable and never the source of truth.
 */
export class Buzz extends pulumi.ComponentResource {
    public readonly app: Application;
    /** `wss://` URL clients connect to; it is the relay's identity in the app. */
    public readonly relayUrl: pulumi.Output<string>;
    public readonly dbConfig?: DatabaseConfig;

    constructor(
        private name: string,
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:nostr:Buzz', name, {}, opts);

        this.app = new Application(this, name).addStorage().addPostgres().addRedis();
        this.dbConfig = this.app.databases?.getConfig();
        const redisConfig = this.app.databases?.getConfig('redis');
        if (!this.dbConfig || !redisConfig) {
            throw new Error('Buzz requires Postgres and Redis');
        }

        const endpoint = this.app.network.getHttpEndpointInfo();
        this.relayUrl = pulumi.interpolate`wss://${endpoint.hostname}`;
        if (this.app.storageOnly) return;

        this.createRelay(endpoint, this.dbConfig, redisConfig);
    }

    private createRelay(
        endpoint: HttpEndpointInfo,
        dbConfig: DatabaseConfig,
        redisConfig: DatabaseConfig,
    ) {
        const waitForDb = this.app.databases?.getWaitContainer(dbConfig);
        const waitForRedis = this.app.databases?.getWaitContainer(redisConfig);

        this.app.addDeployment({
            ports: [
                { name: 'http', port: 3000 },
                { name: 'health', port: 8080, exposure: 'internal' },
                { name: 'metrics', port: 9102, exposure: 'internal' },
            ],
            volumeMounts: [{ mountPath: '/data/git' }],
            // The relay image's default user is buzz:buzz (uid 1000 per its
            // Dockerfile); the git volume must be writable by that uid.
            volumeOwnerUserId: 1000,
            env: {
                BUZZ_ALLOW_NIP_OA_AUTH: 'true',
                BUZZ_AUTO_MIGRATE: 'true',
                BUZZ_BIND_ADDR: '0.0.0.0:3000',
                BUZZ_CORS_ORIGINS: endpoint.url,
                BUZZ_GIT_REPO_PATH: '/data/git',
                BUZZ_HEALTH_PORT: '8080',
                BUZZ_MEDIA_BASE_URL: pulumi.interpolate`${endpoint.url}/media`,
                BUZZ_METRICS_PORT: '9102',
                BUZZ_PUSH_ENABLED: 'false',
                BUZZ_REQUIRE_AUTH_TOKEN: 'true',
                BUZZ_REQUIRE_RELAY_MEMBERSHIP: 'true',
                BUZZ_S3_ADDRESSING_STYLE: 'path',
                BUZZ_S3_BUCKET: config.require(this.name, 's3/bucket'),
                BUZZ_S3_ENDPOINT: config.require(this.name, 's3/endpoint'),
                BUZZ_S3_REGION: 'us-east-1',
                // Without this flag `/` answers browser requests with the NIP-11
                // relay document instead of the web client (block/buzz#3815).
                BUZZ_SERVE_GIT_WEB_GUI: 'true',
                RELAY_OWNER_PUBKEY: toHexPubkey(
                    config.require(this.name, 'ownerPubkey'),
                    `${this.name}:ownerPubkey`,
                ),
                RELAY_URL: this.relayUrl,
                RUST_LOG: this.app.debug
                    ? 'buzz_relay=debug,buzz_db=debug,buzz_auth=debug'
                    : undefined,
            },
            envSecret: {
                BUZZ_GIT_HOOK_HMAC_SECRET: config.requireSecret(
                    this.name,
                    'gitHookHmacSecret',
                ),
                BUZZ_RELAY_PRIVATE_KEY: config.requireSecret(
                    this.name,
                    'relayPrivateKey',
                ),
                BUZZ_S3_ACCESS_KEY: config.requireSecret(this.name, 's3/accessKey'),
                BUZZ_S3_SECRET_KEY: config.requireSecret(this.name, 's3/secretKey'),
                DATABASE_URL: dbConfig.connectionString,
                REDIS_URL: redisConfig.connectionString,
            },
            initContainers: [
                ...(waitForDb ? [waitForDb] : []),
                ...(waitForRedis ? [waitForRedis] : []),
            ],
            // Startup runs migrations and probes the object store, so a cold
            // relay answers late; the liveness probe tolerates that instead of
            // restarting it mid-migration.
            healthCheck: {
                httpGet: { path: '/_liveness', port: 'health' },
                readinessPath: '/_readiness',
                startupFailureThreshold: 60,
            },
            resources: {
                requests: { cpu: '500m', memory: '512Mi' },
                limits: { cpu: '2', memory: '2Gi' },
            },
        });
    }
}
