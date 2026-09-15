import { config } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
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
const homeAssistant = config.isEnabled('home-assistant')
    ? new HomeAssistant('home-assistant', {
          trustedProxies: config.getCommaSeparated('home-assistant', 'trustedProxies'),
          devices: config.getObject('home-assistant', 'devices') as
              | HomeAssistantDevice[]
              | undefined,
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
    mosquitto: mosquitto?.endpoint,
};

export const mqtt = mosquitto
    ? {
          username: mosquitto.username,
          password: pulumi.secret(mosquitto.password),
      }
    : undefined;
