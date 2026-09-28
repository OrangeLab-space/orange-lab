/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { config } from '@orangelab/pulumi';
import { DataModule } from './components/data';
import { HardwareModule } from './components/hardware';
import { MonitoringModule } from './components/monitoring';
import { NetworkModule, NetworkModuleArgs } from './components/network';
import { SecurityModule } from './components/security';
import { StorageModule } from './components/storage';

const securityModule = config.isModuleEnabled('security')
    ? new SecurityModule('security')
    : undefined;
if (securityModule) exports.security = securityModule.getExports();

const oidc: NetworkModuleArgs['oidc'] = securityModule
    ? {
          providerBaseUrl: securityModule.pocket?.oidcProviderBaseUrl,
          providerUrl: securityModule.pocket?.oidcProviderUrl,
      }
    : undefined;

const networkModule = new NetworkModule('network', { oidc });
exports.network = networkModule.getExports();

const storageModule = new StorageModule('storage', { oidc });
exports.storage = storageModule.getExports();

exports.config = {
    customDomain: config.get('orangelab', 'customDomain'),
    adminGroup: config.get('orangelab', 'auth/adminGroup') ?? 'admin',
    longhorn: {
        backupAllVolumes: config.getBoolean('longhorn', 'backupAllVolumes') ?? false,
    },
};

const dataModule = config.isModuleEnabled('data')
    ? new DataModule('data', { dependsOn: [networkModule, storageModule] })
    : undefined;

const hardwareModule = config.isModuleEnabled('hardware')
    ? new HardwareModule('hardware', { dependsOn: [networkModule, storageModule] })
    : undefined;

const baseModules = [
    networkModule,
    storageModule,
    ...(dataModule ? [dataModule] : []),
    ...(hardwareModule ? [hardwareModule] : []),
];

if (config.isModuleEnabled('monitoring')) {
    const monitoringModule = new MonitoringModule(
        'monitoring',
        { oidc },
        { dependsOn: baseModules },
    );
    exports.monitoring = monitoringModule.getExports();
}
