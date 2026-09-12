import { Application, config } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import { BitcoinConf } from '../../utils/bitcoin-conf';
import { RpcUser } from '../../utils/rpc-user';

export interface BitcoinKnotsArgs {
    rpcUsers: Record<string, RpcUser>;
}

export class BitcoinKnots extends pulumi.ComponentResource {
    public readonly app: Application;

    constructor(
        private readonly name: string,
        private args: BitcoinKnotsArgs,
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:bitcoin:BitcoinKnots', name, args, opts);

        const prune = config.requireNumber(name, 'prune');
        const debugExclude = config.require(name, 'debugexclude');
        const externalIp = config.get(name, 'externalip');
        const maxConnections = config.requireNumber(name, 'maxconnections');

        this.app = new Application(this, name);

        this.app.addStorage().addConfigVolume({
            name: 'config',
            files: {
                'bitcoin.conf': BitcoinConf.create({
                    prune,
                    debug: this.app.debug,
                    debugExclude,
                    externalIp,
                    maxConnections,
                    rpcUsers: this.args.rpcUsers,
                    useRpcAuthFile: true,
                }),
                'rpc.conf': BitcoinConf.createRpc(this.args.rpcUsers, true),
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
            command: command ? command.split(' ') : undefined,
            commandArgs: commandArgs.split(' ').filter(Boolean),
            env: {
                BITCOIN_DATA: volumePath,
            },
            image,
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
            ports: [
                { name: 'rpc', port: 8332, protocol: 'tcp' },
                { name: 'p2p', port: 8333, protocol: 'tcp' },
            ],
            resources: {
                requests: { cpu: '1000m', memory: '2Gi' },
                limits: { cpu: '2000m', memory: '8Gi' },
            },
            runAsUser,
            volumeMounts: [
                { mountPath: volumePath },
                { name: 'config', mountPath: '/conf', readOnly: true },
            ],
            volumeOwnerUserId,
        });
    }
}
