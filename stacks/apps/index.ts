import { config, mergeEndpointExports } from '@orangelab/pulumi';
import { Nextcloud } from './components/nextcloud/nextcloud';
import { Vaultwarden } from './components/vaultwarden/vaultwarden';

const nextcloud = config.isEnabled('nextcloud') ? new Nextcloud('nextcloud') : undefined;
const vaultwarden = config.isEnabled('vaultwarden')
    ? new Vaultwarden('vaultwarden')
    : undefined;

export const endpoints = mergeEndpointExports(nextcloud, vaultwarden);

export const apps = {
    nextcloud: nextcloud
        ? {
              users: nextcloud.users,
              db: nextcloud.dbConfig,
          }
        : undefined,
    vaultwarden: vaultwarden
        ? {
              adminToken: vaultwarden.adminToken,
          }
        : undefined,
};
