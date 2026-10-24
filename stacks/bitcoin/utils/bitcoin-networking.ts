/* eslint-disable no-console */
import { config, createTorSidecar, TorSidecar } from '@orangelab/pulumi';
import { isIP } from 'node:net';

/** Values that determine the P2P and Tor lines in `bitcoin.conf`. */
export interface BitcoinNetworkingConf {
    listen: boolean;
    listenOnion: boolean;
    torOnly: boolean;
    torProxy?: string;
    externalIp?: string;
}

/**
 * The resolved P2P networking plan for one node: the values that drive
 * `bitcoin.conf`, plus the Tor sidecar needed to realize onion connectivity.
 */
export interface BitcoinNetworking {
    conf: BitcoinNetworkingConf;
    torSidecar?: TorSidecar;
}

/**
 * Resolve the node's P2P networking settings and, when needed, the Tor sidecar.
 * The cases are:
 *
 * - clearnet private (default): sync and serve Electrs over the cluster only.
 * - clearnet public: publish P2P; `externalip` is required.
 * - clearnet + Tor: publish P2P and add an onion service; `.onion` peers use Tor.
 * - Tor-only: onion inbound, no clearnet P2P listener reachable from outside,
 *   all outbound traffic through Tor.
 *
 * Tor-only assumes the node already synced on clearnet and has onion peers in
 * `peers.dat`. Bitcoin disables DNS seeding under `onlynet=onion` because the
 * built-in seeds are clearnet.
 */
export function resolveBitcoinNetworking(
    name: string,
    publiclyExposed: boolean,
): BitcoinNetworking {
    const torEnabled = config.requireBoolean(name, 'network/tor');
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
            `${name}: externalip must be a clearnet IPv4 or IPv6 address. The onion address is added automatically when network/tor=true.`,
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
    const conf: BitcoinNetworkingConf = {
        externalIp: publiclyExposed ? externalIp : undefined,
        listen,
        listenOnion: torEnabled,
        torOnly: torEnabled && !publiclyExposed,
        torProxy: torEnabled ? '127.0.0.1:9050' : undefined,
    };

    if (!torEnabled) return { conf };

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

    return {
        conf,
        torSidecar: createTorSidecar({
            appName: name,
            control: true,
            runAsUser,
            socks: true,
        }),
    };
}
