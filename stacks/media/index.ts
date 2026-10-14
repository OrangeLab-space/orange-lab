import { config, mergeEndpointExports } from '@orangelab/pulumi';
import { DroppedNeedle } from './components/droppedneedle/droppedneedle';
import { Immich } from './components/immich/immich';
import { Jellyfin } from './components/jellyfin/jellyfin';
import { Lidarr } from './components/lidarr/lidarr';
import { Prowlarr } from './components/prowlarr/prowlarr';
import { Radarr } from './components/radarr/radarr';
import { Seerr } from './components/seerr/seerr';
import { Slskd } from './components/slskd/slskd';
import { Sonarr } from './components/sonarr/sonarr';
import { Transmission } from './components/transmission/transmission';

const jellyfin = config.isEnabled('jellyfin') ? new Jellyfin('jellyfin') : undefined;
const immich = config.isEnabled('immich') ? new Immich('immich') : undefined;
const lidarr = config.isEnabled('lidarr') ? new Lidarr('lidarr') : undefined;
const prowlarr = config.isEnabled('prowlarr') ? new Prowlarr('prowlarr') : undefined;
const radarr = config.isEnabled('radarr') ? new Radarr('radarr') : undefined;
const sonarr = config.isEnabled('sonarr') ? new Sonarr('sonarr') : undefined;
const transmission = config.isEnabled('transmission')
    ? new Transmission('transmission')
    : undefined;

const slskd = config.isEnabled('slskd') ? new Slskd('slskd') : undefined;

const droppedneedle = config.isEnabled('droppedneedle')
    ? new DroppedNeedle('droppedneedle', {
          dependsOn: [slskd, jellyfin].filter(x => x !== undefined),
      })
    : undefined;

const seerr = config.isEnabled('seerr')
    ? new Seerr('seerr', {
          dependsOn: [jellyfin, radarr, sonarr, transmission].filter(
              x => x !== undefined,
          ),
      })
    : undefined;

export const endpoints = mergeEndpointExports(
    droppedneedle,
    immich,
    jellyfin,
    lidarr,
    prowlarr,
    radarr,
    seerr,
    slskd,
    sonarr,
    transmission,
);

export const apps = {
    immich: immich
        ? {
              jwtSecret: immich.jwtSecret,
              db: immich.dbConfig,
          }
        : undefined,
    slskd: slskd
        ? {
              apiKey: slskd.apiKey,
              soulseekUsername: slskd.soulseekUsername,
              soulseekPassword: slskd.soulseekPassword,
              webPassword: slskd.webPassword,
          }
        : undefined,
};
