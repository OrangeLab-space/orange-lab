import { config, mergeEndpointExports } from '@orangelab/pulumi';
import { Buzz } from './components/buzz/buzz';

const buzz = config.isEnabled('buzz') ? new Buzz('buzz') : undefined;

export const endpoints = mergeEndpointExports(buzz);

export const apps = {
    buzz: buzz
        ? {
              relayUrl: buzz.relayUrl,
          }
        : undefined,
};
