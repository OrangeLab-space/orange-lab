import {
    config,
    ConfigVolumeSpec,
    createTorSidecar,
    EmptyVolumeSpec,
    InitContainerSpec,
    SidecarSpec,
} from '@orangelab/pulumi';

const torConfigVolumeName = 'tor-config';
const torRunAsUser = 1000;

export interface TechnitiumTor {
    configVolume: ConfigVolumeSpec;
    forwarderProtocol: string;
    forwarders: string;
    initContainers: InitContainerSpec[];
    sidecars: SidecarSpec[];
    volumes: EmptyVolumeSpec[];
}

/**
 * Route Technitium's upstream DNS through a Tor DNS resolver.
 *
 * The resolver and protocol come from `torResolver` and `torResolverProtocol`;
 * the defaults use Cloudflare's hidden resolver. Technitium's global SOCKS5
 * proxy is UI/API-only, so it must be set to `127.0.0.1:9050` manually. A fresh
 * volume gets the forwarder from the environment; an existing volume needs it
 * updated in the UI too.
 */
export function resolveTechnitiumTor(appName: string): TechnitiumTor | undefined {
    if (!config.requireBoolean(appName, 'network/tor')) return undefined;

    const tor = createTorSidecar({
        appName,
        configVolumeName: torConfigVolumeName,
        runAsUser: torRunAsUser,
    });

    return {
        configVolume: {
            name: torConfigVolumeName,
            files: { torrc: tor.torrc },
        },
        forwarderProtocol: config.require(appName, 'torResolverProtocol'),
        forwarders: config.require(appName, 'torResolver'),
        initContainers: tor.initContainers,
        sidecars: [tor.sidecar],
        volumes: tor.volumes,
    };
}
