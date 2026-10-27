import { Application, config, ServicePort } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import { BitcoinConf } from '../../utils/bitcoin-conf';
import {
    BitcoinNetworking,
    resolveBitcoinNetworking,
} from '../../utils/bitcoin-networking';
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
                    i2pAcceptIncoming: networking.conf.i2pAcceptIncoming,
                    i2pSam: networking.conf.i2pSam,
                    listen: networking.conf.listen,
                    listenOnion: networking.conf.listenOnion,
                    maxConnections,
                    onlynet: networking.conf.onlynet,
                    prune: this.prune,
                    rpcUsers: this.args.rpcUsers,
                    torProxy: networking.conf.torProxy,
                    useRpcAuthFile: false,
                }),
                ...(networking.torSidecar ? { torrc: networking.torSidecar.torrc } : {}),
                ...(networking.i2pSidecar
                    ? { 'i2pd.conf': networking.i2pSidecar.i2pdConf }
                    : {}),
            },
        });

        for (const volume of [
            ...(networking.torSidecar?.volumes ?? []),
            ...(networking.i2pSidecar?.volumes ?? []),
        ]) {
            this.app.addEmptyVolume(volume);
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
                private: networking.conf.privateP2p,
                protocol: 'tcp',
                public: true,
            });
        }

        const sidecars = [
            ...(networking.torSidecar ? [networking.torSidecar.sidecar] : []),
            ...(networking.i2pSidecar ? [networking.i2pSidecar.sidecar] : []),
        ];

        this.app.addDeployment({
            command: command ? command.split(' ') : undefined,
            commandArgs: commandArgs.split(' ').filter(Boolean),
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
                ...(networking.i2pSidecar?.initContainers ?? []),
            ],
            ports,
            resources: {
                requests: { cpu: '600m', memory: '4Gi' },
                limits: { cpu: '2000m', memory: '12Gi' },
            },
            runAsUser,
            sidecars: sidecars.length > 0 ? sidecars : undefined,
            volumeMounts: [
                { mountPath: volumePath },
                ...(networking.torSidecar?.mainVolumeMounts ?? []),
            ],
            volumeOwnerUserId,
        });
    }
}
