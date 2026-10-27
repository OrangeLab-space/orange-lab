/* eslint-disable no-console */
import {
    config,
    createI2pSidecar,
    createTorSidecar,
    I2pSidecar,
    TorSidecar,
} from '@orangelab/pulumi';
import { isIP } from 'node:net';

/** Values that determine the P2P, Tor and I2P lines in `bitcoin.conf`. */
export interface BitcoinNetworkingConf {
    externalIp?: string;
    i2pAcceptIncoming: boolean;
    i2pSam?: string;
    listen: boolean;
    listenOnion: boolean;
    onlynet: string[];
    privateP2p: boolean;
    torProxy?: string;
}

/**
 * The resolved P2P networking plan for one node: the values that drive
 * `bitcoin.conf`, plus the sidecars needed to realize Tor and I2P connectivity.
 */
export interface BitcoinNetworking {
    conf: BitcoinNetworkingConf;
    torSidecar?: TorSidecar;
    i2pSidecar?: I2pSidecar;
}

/**
 * Resolve the node's P2P networking settings and, when needed, the sidecars.
 * The cases are:
 *
 * - clearnet private (default): sync and serve Electrs over the cluster only.
 * - clearnet public: publish P2P; `externalip` is required.
 * - clearnet + Tor/I2P: publish P2P and use the enabled anonymity networks.
 * - Tor/I2P-only: inbound over the enabled networks, no clearnet P2P
 *   listener reachable from outside, all automatic outbound traffic through
 *   those networks.
 * - Tor + I2P: both anonymity networks; inbound is available on each.
 *
 * Tor-only assumes the node already synced on clearnet and has onion peers in
 * `peers.dat`. Bitcoin disables DNS seeding under `onlynet=onion` because the
 * built-in seeds are clearnet. I2P has no DNS seeds either, so a fresh
 * I2P-only node needs known I2P peers or a clearnet sync first.
 */
export function resolveBitcoinNetworking(
    name: string,
    publiclyExposed: boolean,
): BitcoinNetworking {
    const torEnabled = config.requireBoolean(name, 'network/tor');
    const i2pEnabled = config.requireBoolean(name, 'network/i2p');
    const listen = config.requireBoolean(name, 'listen');
    const externalIp = config.get(name, 'externalip')?.trim() ?? undefined;
    const runAsUser = config.getNumber(name, 'runAsUser');

    if (torEnabled && !listen) {
        throw new Error(
            `${name}: network/tor=true requires listen=true because listenonion needs a P2P listener.`,
        );
    }
    if (publiclyExposed && !listen) {
        throw new Error(`${name}: network/public=true requires listen=true.`);
    }
    if (publiclyExposed && !externalIp) {
        throw new Error(
            `${name}: network/public=true requires externalip set to the public clearnet address peers use.`,
        );
    }
    if (publiclyExposed && externalIp && isIP(externalIp) === 0) {
        throw new Error(
            `${name}: externalip must be a clearnet IPv4 or IPv6 address. The onion and I2P addresses are added automatically.`,
        );
    }
    if (!publiclyExposed && externalIp) {
        console.warn(`${name}: externalip is ignored because network/public=false.`);
    }
    if (!listen && config.isEnabled('electrs')) {
        throw new Error(
            `${name}: listen=false is incompatible with electrs, which needs the P2P port.`,
        );
    }

    const onlynet = publiclyExposed
        ? []
        : [...(torEnabled ? ['onion'] : []), ...(i2pEnabled ? ['i2p'] : [])];
    const conf: BitcoinNetworkingConf = {
        externalIp: publiclyExposed ? externalIp : undefined,
        i2pAcceptIncoming: i2pEnabled && listen,
        i2pSam: i2pEnabled ? '127.0.0.1:7656' : undefined,
        listen,
        listenOnion: torEnabled,
        onlynet,
        privateP2p: !publiclyExposed && (torEnabled || i2pEnabled),
        torProxy: torEnabled ? '127.0.0.1:9050' : undefined,
    };

    let torSidecar: TorSidecar | undefined;
    if (torEnabled) {
        if (!runAsUser || runAsUser <= 0) {
            throw new Error(
                `${name}: network/tor=true requires a non-root runAsUser so Bitcoin and the Tor sidecar share the control cookie.`,
            );
        }
        const volumeOwnerUserId = config.getNumber(name, 'volumeOwnerUserId');
        if (volumeOwnerUserId !== undefined && volumeOwnerUserId !== runAsUser) {
            throw new Error(
                `${name}: network/tor=true requires volumeOwnerUserId to match runAsUser so the control cookie stays readable.`,
            );
        }
        torSidecar = createTorSidecar({
            appName: name,
            control: true,
            runAsUser,
            socks: true,
        });
    }

    return {
        conf,
        torSidecar,
        i2pSidecar: i2pEnabled ? createI2pSidecar({ appName: name }) : undefined,
    };
}
