import { Application, config } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import { RpcUser } from '../../utils/rpc-user';

export interface ElectrsArgs {
    rpcUser: RpcUser;
    bitcoinRpcUrl: pulumi.Input<string>;
    bitcoinP2pUrl: pulumi.Input<string>;
}

export class Electrs extends pulumi.ComponentResource {
    public readonly app: Application;

    constructor(
        private readonly name: string,
        private args: ElectrsArgs,
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:bitcoin:Electrs', name, args, opts);

        const rpcHost = pulumi
            .output(this.args.bitcoinRpcUrl)
            .apply(url => new URL(`http://${url}`).host);

        this.app = new Application(this, name);

        this.app.addStorage().addConfigVolume({
            name: 'config',
            files: {
                'electrs.toml': pulumi.interpolate`
                        auth = "${this.args.rpcUser.username}:${
                            this.args.rpcUser.password
                        }"
                        daemon_rpc_addr = "${rpcHost}"
                        daemon_p2p_addr = "${this.args.bitcoinP2pUrl}"
                        db_dir = "/data"
                        electrum_rpc_addr = "0.0.0.0:50001"
                        log_filters = ${this.app.debug ? '"DEBUG"' : '"INFO"'}
                    `,
            },
        });
        this.createDeployment();
    }

    private createDeployment() {
        if (!this.args.bitcoinRpcUrl || !this.args.bitcoinP2pUrl) return;
        const extraArgs = config.get(this.name, 'extraArgs') ?? '';
        this.app.addDeployment({
            ports: [{ name: 'rpc', port: 50001, protocol: 'tls' }],
            runAsUser: 1000,
            commandArgs: [
                '--conf=/conf/electrs.toml',
                ...extraArgs.split(' ').filter(Boolean),
            ],
            volumeMounts: [
                { mountPath: '/data' },
                { name: 'config', mountPath: '/conf' },
            ],
            resources: {
                requests: { cpu: '200m', memory: '1Gi' },
                limits: { cpu: '2000m', memory: '4Gi' },
            },
        });
    }
}
