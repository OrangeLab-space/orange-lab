import { config } from '@orangelab/pulumi';
import {
    HomeAssistant,
    HomeAssistantDevice,
} from './components/home-assistant/home-assistant';
import { MatterServer } from './components/matter/matter';
import { OpenThreadBorderRouter } from './components/openthread/openthread';

const homeAssistant = config.isEnabled('home-assistant')
    ? new HomeAssistant('home-assistant', {
          trustedProxies: (config.get('home-assistant', 'trustedProxies') ?? '')
              .split(',')
              .map(s => s.trim())
              .filter(Boolean),
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
};
