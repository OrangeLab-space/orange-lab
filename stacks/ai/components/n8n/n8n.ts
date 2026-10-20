import { Application, config, DatabaseConfig } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

export interface N8nArgs {
    ollamaUrl?: string;
}

export class N8n extends pulumi.ComponentResource {
    app: Application;
    encryptionKey: pulumi.Output<string>;
    postgresConfig?: DatabaseConfig;

    constructor(
        private name: string,
        args: N8nArgs,
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:ai:N8n', name, args, opts);

        this.app = new Application(this, name).addStorage().addPostgres();
        this.encryptionKey = config.requireSecret(name, 'N8N_ENCRYPTION_KEY');

        this.postgresConfig = this.app.databases?.getConfig();
        const initContainer = this.app.databases?.getWaitContainer();
        this.app.addDeployment({
            ports: [{ name: 'http', port: 5678 }],
            volumeMounts: [{ mountPath: '/home/node/.n8n' }],
            volumeOwnerUserId: 1000,
            resources: {
                requests: { cpu: '100m', memory: '768Mi' },
                limits: { cpu: '1', memory: '1Gi' },
            },
            env: {
                CREDENTIALS_OVERWRITE_DATA: args.ollamaUrl
                    ? `{"ollamaApi": {"baseUrl": "${args.ollamaUrl}"}}`
                    : undefined,
                DB_TYPE: 'postgresdb',
                N8N_DIAGNOSTICS_ENABLED: 'false',
                N8N_ENCRYPTION_KEY: this.encryptionKey,
                N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: 'true',
                N8N_HOST: this.app.network.getHttpEndpointInfo().hostname,
                N8N_LOG_LEVEL: this.app.debug ? 'debug' : undefined,
                N8N_METRICS: config.enableMonitoring() ? 'true' : 'false',
                N8N_PORT: '5678',
                N8N_PROTOCOL: 'http',
                N8N_PROXY_HOPS: '1',
                N8N_SECURE_COOKIE: 'false',
                N8N_WEBHOOK_URL: this.app.network.getHttpEndpointInfo().url,
            },
            envSecret: {
                DB_POSTGRESDB_DATABASE: this.postgresConfig?.database,
                DB_POSTGRESDB_HOST: this.postgresConfig?.hostname,
                DB_POSTGRESDB_PASSWORD: this.postgresConfig?.password,
                DB_POSTGRESDB_USER: this.postgresConfig?.username,
            },
            initContainers: initContainer ? [initContainer] : undefined,
        });
    }

}
