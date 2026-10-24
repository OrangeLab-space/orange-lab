import { Application, config, ServicePort } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import { BitcoinConf } from '../../utils/bitcoin-conf';
import {
    BitcoinNetworking,
    resolveBitcoinNetworking,
} from '../../utils/bitcoin-networking';
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
        const maxConnections = config.requireNumber(name, 'maxconnections');

        this.app = new Application(this, name);
        const networking = resolveBitcoinNetworking(
            name,
            this.app.network.publiclyExposed,
        );

        this.app.addStorage().addConfigVolume({
            name: 'config',
            files: {
                'bitcoin.conf': BitcoinConf.create({
                    debug: this.app.debug,
                    debugExclude,
                    externalIp: networking.conf.externalIp,
                    listen: networking.conf.listen,
                    listenOnion: networking.conf.listenOnion,
                    maxConnections,
                    prune,
                    rpcUsers: this.args.rpcUsers,
                    torOnly: networking.conf.torOnly,
                    torProxy: networking.conf.torProxy,
                    useRpcAuthFile: true,
                }),
                'rpc.conf': BitcoinConf.createRpc(this.args.rpcUsers, true),
                ...(networking.torSidecar ? { torrc: networking.torSidecar.torrc } : {}),
            },
        });

        if (networking.torSidecar) {
            for (const volume of networking.torSidecar.volumes) {
                this.app.addEmptyVolume(volume);
            }
        }

        this.createDeployment(networking);
    }

    private createDeployment(networking: BitcoinNetworking) {
        const command = config.get(this.name, 'command');
        const commandArgs = config.get(this.name, 'commandArgs') ?? '';
        const image = config.require(this.name, 'image');
        const runAsUser = config.getNumber(this.name, 'runAsUser');
        const volumeOwnerUserId = config.getNumber(this.name, 'volumeOwnerUserId');
        const volumePath = config.require(this.name, 'volumePath');

        const ports: ServicePort[] = [{ name: 'rpc', port: 8332, protocol: 'tcp' }];
        if (networking.conf.listen) {
            ports.push({
                name: 'p2p',
                port: 8333,
                private: networking.conf.torOnly,
                protocol: 'tcp',
                public: true,
            });
        }

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
                ...(networking.torSidecar?.initContainers ?? []),
            ],
            ports,
            resources: {
                requests: { cpu: '600m', memory: '4Gi' },
                limits: { cpu: '2000m', memory: '12Gi' },
            },
            runAsUser,
            sidecars: networking.torSidecar ? [networking.torSidecar.sidecar] : undefined,
            volumeMounts: [
                { mountPath: volumePath },
                { name: 'config', mountPath: '/conf', readOnly: true },
                ...(networking.torSidecar?.mainVolumeMounts ?? []),
            ],
            volumeOwnerUserId,
        });
    }
}
