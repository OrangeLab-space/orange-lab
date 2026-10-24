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
    torOnly,
    torProxy,
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
    torOnly: boolean;
    torProxy?: string;
}): pulumi.Output<string> {
    if (listenOnion && !listen) {
        throw new Error('listenonion requires listen=true');
    }
    if (torOnly && !torProxy) {
        throw new Error('tor-only mode requires a Tor SOCKS proxy');
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

    const proxy = torProxy ?? '127.0.0.1:9050';
    const torLines = [
        `listenonion=${listenOnion ? '1' : '0'}`,
        ...(listenOnion ? ['torcontrol=127.0.0.1:9051'] : []),
        ...(torOnly
            ? [`proxy=${proxy}`, 'onlynet=onion']
            : torProxy
              ? [`onion=${torProxy}`]
              : []),
    ].join('\n');

    return pulumi.interpolate`
${prune > 0 ? `prune=${prune.toString()}` : 'txindex=1'}
${externalIp ? `externalip=${externalIp}` : ''}
${debug ? 'debug=all' : ''}
${debugExcludeLines}
disablewallet=1
listen=${listen ? '1' : '0'}
${torLines}
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
