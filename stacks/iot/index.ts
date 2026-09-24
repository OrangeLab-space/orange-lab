import { config } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import { Frigate } from './components/frigate/frigate';
import {
    HomeAssistant,
    HomeAssistantDevice,
} from './components/home-assistant/home-assistant';
import { MatterServer } from './components/matter/matter';
import { Mosquitto } from './components/mosquitto/mosquitto';
import { OpenThreadBorderRouter } from './components/openthread/openthread';

const mosquitto = config.isEnabled('mosquitto')
    ? new Mosquitto('mosquitto')
    : undefined;

const frigate = config.isEnabled('frigate')
    ? new Frigate('frigate', {
          mqtt: mosquitto
              ? {
                    host: mosquitto.host,
                    password: mosquitto.password,
                    port: mosquitto.port,
                    username: mosquitto.username,
                }
              : undefined,
      })
    : undefined;

const homeAssistant = config.isEnabled('home-assistant')
    ? new HomeAssistant('home-assistant', {
          trustedProxies: config.getCommaSeparated('home-assistant', 'trustedProxies'),
          devices: config.getObject('home-assistant', 'devices') as
              | HomeAssistantDevice[]
              | undefined,
          frigateIntegration: frigate !== undefined,
      })
    : undefined;

const openThreadBorderRouter = config.isEnabled('openthread')
    ? new OpenThreadBorderRouter('openthread')
    : undefined;

const matterServer = config.isEnabled('matter')
    ? new MatterServer('matter')
    : undefined;

export const endpoints = {
    homeAssistant: homeAssistant?.endpointUrl,
    openThreadRestApi: openThreadBorderRouter?.restApiUrl,
    matterDashboard: matterServer?.endpointUrl,
    matterWebsocket: matterServer?.websocketUrl,
    frigate: frigate?.endpointUrl,
    mosquitto: mosquitto?.endpoint,
};

export const mqtt = mosquitto
    ? {
          username: mosquitto.username,
          password: pulumi.secret(mosquitto.password),
      }
    : undefined;

export const apps = {
    frigate: frigate
        ? {
              proxySecret: frigate.proxySecret,
          }
        : undefined,
};
