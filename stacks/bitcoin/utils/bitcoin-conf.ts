import { config } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

import { RpcUser } from './rpc-user';

function createRpc(
    rpcUsers: Record<string, RpcUser>,
    useRpcAuthFile: boolean,
): pulumi.Output<string> {
    const authLines = Object.values(rpcUsers).map(user =>
        useRpcAuthFile
            ? pulumi.interpolate`${user.rpcAuth}`
            : pulumi.interpolate`rpcauth=${user.rpcAuth}`,
    );
    return pulumi.all(authLines).apply(lines => lines.join('\n'));
}

function create({
    prune,
    debug,
    debugExclude,
    externalIp,
    maxConnections,
    rpcUsers,
    useRpcAuthFile,
    listen,
    listenOnion,
    torProxy,
    i2pSam,
    i2pAcceptIncoming,
    onlynet,
}: {
    prune: number;
    debug?: boolean;
    debugExclude: string;
    externalIp?: string;
    maxConnections: number;
    rpcUsers: Record<string, RpcUser>;
    useRpcAuthFile: boolean;
    listen: boolean;
    listenOnion: boolean;
    torProxy?: string;
    i2pSam?: string;
    i2pAcceptIncoming: boolean;
    onlynet: string[];
}): pulumi.Output<string> {
    if (listenOnion && !listen) {
        throw new Error('listenonion requires listen=true');
    }
    if (onlynet.includes('onion') && !torProxy) {
        throw new Error('onion-only networking requires a Tor SOCKS proxy');
    }
    if (onlynet.includes('i2p') && !i2pSam) {
        throw new Error('I2P-only networking requires an I2P SAM proxy');
    }

    const debugExcludeLines = debugExclude
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
        .map(value => `debugexclude=${value}`)
        .join('\n');

    const whitelist = config.require('bitcoin', 'whitelist');

    const rpcAuth = useRpcAuthFile
        ? pulumi.output('rpcauthfile=/conf/rpc.conf')
        : createRpc(rpcUsers, useRpcAuthFile);

    const privacyLines = [
        `listenonion=${listenOnion ? '1' : '0'}`,
        ...(listenOnion ? ['torcontrol=127.0.0.1:9051'] : []),
        ...(torProxy
            ? onlynet.length > 0
                ? [`proxy=${torProxy}`]
                : [`onion=${torProxy}`]
            : []),
        ...(i2pSam
            ? [`i2psam=${i2pSam}`, `i2pacceptincoming=${i2pAcceptIncoming ? '1' : '0'}`]
            : []),
        ...onlynet.map(network => `onlynet=${network}`),
    ].join('\n');

    return pulumi.interpolate`
${prune > 0 ? `prune=${prune.toString()}` : 'txindex=1'}
${externalIp ? `externalip=${externalIp}` : ''}
${debug ? 'debug=all' : ''}
${debugExcludeLines}
disablewallet=1
listen=${listen ? '1' : '0'}
${privacyLines}
maxconnections=${maxConnections.toString()}
nodebuglogfile=1
printtoconsole=1
rpcallowip=0.0.0.0/0
rpcbind=0.0.0.0
server=1
whitelist=in,noban@${whitelist}
${rpcAuth}
`;
}

export const BitcoinConf = {
    createRpc,
    create,
};
