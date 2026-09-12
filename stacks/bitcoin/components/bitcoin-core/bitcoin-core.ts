import { Application, config } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import { BitcoinConf } from '../../utils/bitcoin-conf';
import { RpcUser } from '../../utils/rpc-user';

export interface BitcoinCoreArgs {
    rpcUsers: Record<string, RpcUser>;
}

export class BitcoinCore extends pulumi.ComponentResource {
    public readonly app: Application;
    private readonly prune: number;

    constructor(
        private name: string,
        private args: BitcoinCoreArgs,
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:bitcoin:BitcoinCore', name, args, opts);

        this.prune = config.requireNumber(name, 'prune');
        const debugExclude = config.require(name, 'debugexclude');
        const externalIp = config.get(name, 'externalip');
        const maxConnections = config.requireNumber(name, 'maxconnections');

        this.app = new Application(this, name);

        this.app.addStorage().addConfigVolume({
            name: 'config',
            files: {
                'bitcoin.conf': BitcoinConf.create({
                    prune: this.prune,
                    debug: this.app.debug,
                    debugExclude,
                    externalIp,
                    maxConnections,
                    rpcUsers: this.args.rpcUsers,
                    useRpcAuthFile: false,
                }),
            },
        });

        this.createDeployment();
    }

    private createDeployment() {
        const command = config.get(this.name, 'command');
        const commandArgs = config.get(this.name, 'commandArgs') ?? '';
        const image = config.require(this.name, 'image');
        const runAsUser = config.getNumber(this.name, 'runAsUser');
        const volumeOwnerUserId = config.getNumber(this.name, 'volumeOwnerUserId');
        const volumePath = config.require(this.name, 'volumePath');

        this.app.addDeployment({
            resources: {
                requests: { cpu: '100m', memory: '2Gi' },
                limits: { cpu: '2000m', memory: '8Gi' },
            },
            image,
            ports: [
                { name: 'rpc', port: 8332, protocol: 'tcp' },
                { name: 'p2p', port: 8333, protocol: 'tcp' },
            ],
            command: command ? command.split(' ') : undefined,
            commandArgs: commandArgs.split(' ').filter(Boolean),
            initContainers: [
                {
                    name: 'copy-config',
                    command: [
                        'sh',
                        '-c',
                        `cp -v /conf/bitcoin.conf ${volumePath}/bitcoin.conf`,
                    ],
                    volumeMounts: [
                        { name: 'config', mountPath: '/conf', readOnly: true },
                        { mountPath: volumePath },
                    ],
                },
            ],
            runAsUser,
            volumeOwnerUserId,
            volumeMounts: [{ mountPath: volumePath }],
        });
    }
}
