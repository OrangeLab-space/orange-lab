import { Application, config, DatabaseConfig } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import { RpcUser } from '../../utils/rpc-user';

export interface MempoolArgs {
    electrsUrl: pulumi.Input<string>;
    rpcUser: RpcUser;
    bitcoinRpcUrl: pulumi.Input<string>;
}

export class Mempool extends pulumi.ComponentResource {
    public readonly app: Application;
    public dbConfig?: DatabaseConfig;

    constructor(
        private readonly name: string,
        private args: MempoolArgs,
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:bitcoin:Mempool', name, args, opts);

        this.app = new Application(this, name).addMariaDB();
        this.dbConfig = this.app.databases?.getConfig();
        if (this.app.storageOnly) return;
        this.createDeployment();
    }

    private createDeployment() {
        const backendHostname = config.require(this.name, 'backend/hostname');
        const rpcUrl = pulumi
            .output(this.args.bitcoinRpcUrl)
            .apply(url => new URL(`http://${url}`));
        const electrsUrl = pulumi.output(this.args.electrsUrl).apply(url => {
            const [host, port] = url.split(':');
            return { host, port };
        });

        const waitForDb = this.app.databases?.getWaitContainer();
        this.app
            .addDeployment({
                name: 'backend',
                image: config.require(this.name, 'backend/image'),
                ports: [
                    {
                        name: 'http',
                        port: 8999,
                        hostname: backendHostname,
                        private: true,
                    },
                ],
                env: {
                    CORE_RPC_HOST: rpcUrl.hostname,
                    CORE_RPC_PORT: rpcUrl.port,
                    DATABASE_DATABASE: this.dbConfig?.database,
                    DATABASE_ENABLED: 'true',
                    DATABASE_HOST: this.dbConfig?.hostname,
                    ELECTRUM_HOST: electrsUrl.host,
                    ELECTRUM_PORT: electrsUrl.port,
                    ELECTRUM_TLS_ENABLED: 'false',
                    FIAT_PRICE_ENABLED: 'false',
                    MEMPOOL_BACKEND: 'electrum',
                },
                envSecret: {
                    CORE_RPC_USERNAME: this.args.rpcUser.username,
                    CORE_RPC_PASSWORD: this.args.rpcUser.password,
                    DATABASE_PASSWORD: this.dbConfig?.password,
                    DATABASE_USERNAME: this.dbConfig?.username,
                },
                initContainers: waitForDb ? [waitForDb] : undefined,
                resources: {
                    requests: { cpu: '300m', memory: '1Gi' },
                    limits: { cpu: '1000m', memory: '4Gi' },
                },
            })
            .addDeployment({
                name: 'frontend',
                image: config.require(this.name, 'frontend/image'),
                ports: [{ name: 'http', port: 8080 }],
                env: {
                    FRONTEND_HTTP_PORT: '8080',
                    BACKEND_MAINNET_HTTP_HOST: backendHostname,
                },
                resources: {
                    requests: { cpu: '50m', memory: '128Mi' },
                    limits: { cpu: '500m', memory: '512Mi' },
                },
            });
    }
}
