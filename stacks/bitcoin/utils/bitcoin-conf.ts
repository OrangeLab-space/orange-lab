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
}: {
    prune: number;
    debug?: boolean;
    debugExclude: string;
    externalIp?: string;
    maxConnections: number;
    rpcUsers: Record<string, RpcUser>;
    useRpcAuthFile: boolean;
}): pulumi.Output<string> {
    const debugExcludeLines = debugExclude
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
        .map(value => `debugexclude=${value}`)
        .join('\n');

    const rpcAuth = useRpcAuthFile
        ? pulumi.output('rpcauthfile=/conf/rpc.conf')
        : createRpc(rpcUsers, useRpcAuthFile);

    return pulumi.interpolate`
${prune > 0 ? `prune=${prune.toString()}` : 'txindex=1'}
${externalIp ? `externalip=${externalIp}` : ''}
${debug ? 'debug=all' : ''}
${debugExcludeLines}
disablewallet=1
listen=1
listenonion=0
maxconnections=${maxConnections.toString()}
nodebuglogfile=1
printtoconsole=1
rpcallowip=0.0.0.0/0
rpcbind=0.0.0.0
server=1
${rpcAuth}
`;
}

export const BitcoinConf = {
    createRpc,
    create,
};
