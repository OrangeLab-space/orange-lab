import { Application, config } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

export interface HomeAssistantDevice {
    name: string;
    device: string;
}

export interface HomeAssistantArgs {
    trustedProxies?: string[];
    devices?: HomeAssistantDevice[];
}

export class HomeAssistant extends pulumi.ComponentResource {
    public readonly endpointUrl?: pulumi.Input<string>;
    private readonly app: Application;

    constructor(name: string, args: HomeAssistantArgs, opts?: pulumi.ResourceOptions) {
        super('orangelab:iot:HomeAssistant', name, args, opts);

        this.app = new Application(this, name, {
            oidc: { publicClient: true },
        }).addStorage();

        if (this.app.storageOnly) return;
        const httpEndpointInfo = this.app.network.getHttpEndpointInfo();

        this.createHelmChart(name, args);
        this.app.addHostNetworkProxy({ targetPort: 8080, serviceAccountName: name });

        this.endpointUrl = httpEndpointInfo.url;
    }

    private createHelmChart(name: string, args: HomeAssistantArgs) {
        this.app.addHelmChart(
            name,
            {
                chart: 'home-assistant',
                repo: 'http://pajikos.github.io/home-assistant-helm-chart/',
                values: {
                    additionalMounts: [
                        { mountPath: '/run/dbus', name: 'dbus', readOnly: true },
                        ...(args.devices ?? []).map(({ name, device }) => ({
                            name,
                            mountPath: device,
                        })),
                    ],
                    additionalVolumes: [
                        {
                            name: 'dbus',
                            hostPath: { path: '/run/dbus', type: 'Directory' },
                        },
                        ...(args.devices ?? []).map(({ name, device }) => ({
                            name,
                            hostPath: { path: device, type: 'CharDevice' },
                        })),
                        ...(this.app.oidc
                            ? [
                                  {
                                      name: 'ha-config',
                                      persistentVolumeClaim: {
                                          claimName: this.app.storage?.getClaimName(),
                                      },
                                  },
                                  { name: 'oidc-scratch', emptyDir: {} },
                              ]
                            : []),
                    ],
                    affinity: this.app.nodes.getAffinity(),
                    configuration: {
                        enabled: true,
                        trusted_proxies: args.trustedProxies ?? [],
                        ...(this.app.oidc && {
                            initContainer: this.getOidcInitContainer(name),
                        }),
                    },
                    controller: {
                        type: 'Deployment',
                    },
                    deploymentStrategy: 'Recreate',
                    dnsPolicy: 'ClusterFirstWithHostNet',
                    fullnameOverride: name,
                    hostNetwork: true,
                    ingress: { enabled: false },
                    ...(this.app.oidc && {
                        initContainers: [this.getOidcInstallContainer(name)],
                    }),
                    persistence: {
                        enabled: true,
                        existingClaim: this.app.storage?.getClaimName(),
                    },
                    replicaCount: 1,
                    securityContext: {
                        capabilities: {
                            add: ['NET_ADMIN', 'NET_RAW'],
                        },
                        seccompProfile: {
                            type: 'RuntimeDefault',
                        },
                        seLinuxOptions: {
                            type: 'spc_t',
                        },
                        privileged: Boolean(args.devices?.length),
                    },
                },
            },
            { dependsOn: this.app.storage },
        );
    }

    private getOidcInitContainer(name: string) {
        const adminGroup = config.require(name, 'auth/adminGroup');
        return {
            env: [
                { name: 'OIDC_CLIENT_ID', value: this.app.oidc?.clientId },
                { name: 'OIDC_DISCOVERY_URL', value: this.getDiscoveryUrl() },
                ...(adminGroup
                    ? [{ name: 'OIDC_ADMIN_GROUP', value: adminGroup }]
                    : []),
            ],
            args: [
                [
                    'set -e',
                    '/bin/sh /mnt/init/init.sh',
                    `yq -i '${this.getOidcYq(adminGroup)}' /config/configuration.yaml`,
                ].join('\n'),
            ],
        };
    }

    private getOidcYq(adminGroup: string) {
        return [
            '.auth_oidc.client_id = strenv(OIDC_CLIENT_ID)',
            '.auth_oidc.discovery_url = strenv(OIDC_DISCOVERY_URL)',
            '.auth_oidc.features.force_https = true',
            '.auth_oidc.features.automatic_user_linking = true',
            ...(adminGroup ? ['.auth_oidc.roles.admin = strenv(OIDC_ADMIN_GROUP)'] : []),
        ].join(' | ');
    }

    private getOidcInstallContainer(name: string) {
        return {
            name: 'install-oidc-auth',
            image: 'alpine:3.21',
            command: ['/bin/sh', '-c'],
            env: [
                { name: 'OIDC_REPO', value: config.require(name, 'oidcRepo') },
                {
                    name: 'OIDC_VERSION',
                    value: config.require(name, 'oidcVersion'),
                },
            ],
            args: [
                [
                    'set -e',
                    'install_dir=/config/custom_components/auth_oidc',
                    'marker="$install_dir/.orangelab-version"',
                    'marker_value="zip:$OIDC_VERSION"',
                    'if [ -f "$marker" ] && [ -f "$install_dir/manifest.json" ] && [ "$(cat "$marker")" = "$marker_value" ]; then',
                    '    echo "auth_oidc $OIDC_VERSION already installed"',
                    '    exit 0',
                    'fi',
                    'url="${OIDC_REPO%/}/releases/download/${OIDC_VERSION}/hass-oidc-auth.zip"',
                    'if ! wget -q -O /git/hass-oidc-auth.zip "$url"; then',
                    '    if [ -f "$install_dir/manifest.json" ]; then',
                    '        echo "WARNING: could not fetch auth_oidc $OIDC_VERSION, keeping existing install" >&2',
                    '        exit 0',
                    '    fi',
                    '    echo "ERROR: could not fetch auth_oidc $OIDC_VERSION and no existing install" >&2',
                    '    exit 1',
                    'fi',
                    'rm -rf "$install_dir"',
                    'mkdir -p "$install_dir"',
                    'unzip -q -o /git/hass-oidc-auth.zip -d "$install_dir"',
                    'echo "$marker_value" > "$marker"',
                    'chmod -R a+rX "$install_dir"',
                ].join('\n'),
            ],
            volumeMounts: [
                { name: 'ha-config', mountPath: '/config' },
                { name: 'oidc-scratch', mountPath: '/git' },
            ],
        };
    }

    private getDiscoveryUrl() {
        return pulumi.output(this.app.oidc?.providerUrl).apply(url => {
            if (!url) {
                throw new Error(
                    'Home Assistant: OIDC enabled (home-assistant:auth) but the OIDC provider URL is unavailable. Set orangelab:coreStackRef to a deployed core stack with Pocket ID enabled.',
                );
            }
            return url;
        });
    }
}
