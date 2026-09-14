import { config } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import assert from 'assert';
import { BitcoinCore } from './components/bitcoin-core/bitcoin-core';
import { BitcoinKnots } from './components/bitcoin-knots/bitcoin-knots';
import { Electrs } from './components/electrs/electrs';
import { Mempool } from './components/mempool/mempool';
import { RpcUser } from './utils/rpc-user';

const usernames = config.requireCommaSeparated('bitcoin', 'rpcUsers');
const rpcUsers: Record<string, RpcUser> = {};
const bitcoinUsers: Record<string, pulumi.Output<string>> = {};

usernames.forEach(username => {
    rpcUsers[username] = new RpcUser('bitcoin', { username });
    bitcoinUsers[username] = rpcUsers[username].password;
});

const bitcoinKnots = config.isEnabled('bitcoin-knots')
    ? new BitcoinKnots('bitcoin-knots', { rpcUsers })
    : undefined;

const bitcoinCore = config.isEnabled('bitcoin-core')
    ? new BitcoinCore('bitcoin-core', { rpcUsers })
    : undefined;

const bitcoinRpcUrl =
    bitcoinKnots?.app.network.clusterEndpoints['bitcoin-knots-rpc'] ??
    bitcoinCore?.app.network.clusterEndpoints['bitcoin-core-rpc'];
const bitcoinP2pUrl =
    bitcoinKnots?.app.network.clusterEndpoints['bitcoin-knots-p2p'] ??
    bitcoinCore?.app.network.clusterEndpoints['bitcoin-core-p2p'];

const electrs =
    config.isEnabled('electrs') && bitcoinRpcUrl && bitcoinP2pUrl
        ? new Electrs('electrs', {
              rpcUser: rpcUsers.electrs,
              bitcoinRpcUrl,
              bitcoinP2pUrl,
          })
        : undefined;

if (config.isEnabled('electrs')) {
    assert(bitcoinRpcUrl && bitcoinP2pUrl, 'Bitcoin node must be enabled for Electrs');
}

const mempool =
    config.isEnabled('mempool') && electrs && bitcoinRpcUrl
        ? new Mempool('mempool', {
              electrsUrl: electrs.app.network.clusterEndpoints['electrs-rpc'],
              rpcUser: rpcUsers.mempool,
              bitcoinRpcUrl,
          })
        : undefined;

if (config.isEnabled('mempool')) {
    assert(electrs, 'Electrs must be enabled for Mempool');
    assert(bitcoinRpcUrl, 'Bitcoin RPC must be enabled for Mempool');
}

const bitcoinUserPasswords = Object.fromEntries(
    Object.entries(bitcoinUsers).map(([user, password]) => [
        user,
        pulumi.secret(password),
    ]),
);

export const endpoints = {
    ...bitcoinCore?.app.network.endpoints,
    ...bitcoinKnots?.app.network.endpoints,
    ...electrs?.app.network.endpoints,
    ...mempool?.app.network.endpoints,
};

export const clusterEndpoints = {
    ...bitcoinCore?.app.network.clusterEndpoints,
    ...bitcoinKnots?.app.network.clusterEndpoints,
    ...electrs?.app.network.clusterEndpoints,
    ...mempool?.app.network.clusterEndpoints,
};

export const apps = {
    mempool: mempool ? { db: mempool.dbConfig } : undefined,
    bitcoin: { users: bitcoinUserPasswords },
};
