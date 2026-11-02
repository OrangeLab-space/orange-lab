import { config, mergeEndpointExports } from '@orangelab/pulumi';
import { Agentgateway } from './components/agentgateway/agentgateway';
import { Automatic1111 } from './components/automatic1111/automatic1111';
import { ComfyUI } from './components/comfyui/comfyui';
import { InvokeAi } from './components/invokeai/invokeai';
import { KubeAi } from './components/kubeai/kubeai';
import { N8n } from './components/n8n/n8n';
import { Ollama } from './components/ollama/ollama';
import { ImageGenerationConnection, OpenWebUI } from './components/open-webui/open-webui';
import { SDNext } from './components/sdnext/sdnext';
import { Speaches } from './components/speaches/speaches';

const ollama = config.isEnabled('ollama') ? new Ollama('ollama') : undefined;

const speaches = config.isEnabled('speaches') ? new Speaches('speaches') : undefined;

const agentgateway = config.isEnabled('agentgateway')
    ? new Agentgateway('agentgateway')
    : undefined;

const automatic1111 = config.isEnabled('automatic1111')
    ? new Automatic1111('automatic1111')
    : undefined;

const sdnext = config.isEnabled('sdnext') ? new SDNext('sdnext') : undefined;

const comfyui = config.isEnabled('comfyui') ? new ComfyUI('comfyui') : undefined;

/**
 * ComfyUI and Automatic1111 use different APIs; SD.Next exposes the
 * Automatic1111 one. Connect a single backend, in that order of preference.
 */
function getImageGeneration(): ImageGenerationConnection | undefined {
    if (comfyui) {
        return {
            engine: 'comfyui',
            model: comfyui.model,
            url: comfyui.app.network.clusterEndpoints.comfyui,
        };
    }
    if (sdnext) {
        return {
            engine: 'automatic1111',
            url: sdnext.app.network.clusterEndpoints.sdnext,
        };
    }
    if (automatic1111) {
        return {
            engine: 'automatic1111',
            url: automatic1111.app.network.clusterEndpoints.automatic1111,
        };
    }
    return undefined;
}

const kubeAI = config.isEnabled('kubeai') ? new KubeAi('kubeai') : undefined;

const openWebUI = config.isEnabled('open-webui')
    ? new OpenWebUI(
          'open-webui',
          {
              agentgatewayApiKey: agentgateway?.apiKeys['open-webui'],
              agentgatewayUrl: agentgateway?.apiUrl,
              imageGeneration: getImageGeneration(),
              ollamaUrl: ollama?.serviceUrl,
              speech: speaches
                  ? {
                        sttModel: speaches.sttModel,
                        ttsModel: speaches.ttsModel,
                        ttsVoice: speaches.ttsVoice,
                        url: speaches.apiUrl,
                    }
                  : undefined,
          },
          {
              dependsOn: [
                  agentgateway,
                  ollama,
                  speaches,
                  automatic1111,
                  sdnext,
                  comfyui,
              ].filter(x => x !== undefined),
          },
      )
    : undefined;

const invokeAi = config.isEnabled('invokeai') ? new InvokeAi('invokeai') : undefined;

const n8n = config.isEnabled('n8n')
    ? new N8n('n8n', { ollamaUrl: ollama?.serviceUrl })
    : undefined;

export const endpoints = mergeEndpointExports(
    agentgateway,
    automatic1111,
    comfyui,
    invokeAi,
    kubeAI,
    ollama,
    openWebUI,
    sdnext,
    speaches,
    n8n,
);

export const apps = {
    agentgateway: agentgateway
        ? {
              ...agentgateway.links,
              apiKeys: agentgateway.apiKeys,
          }
        : undefined,
    'open-webui': openWebUI
        ? {
              secretKey: openWebUI.secretKey,
          }
        : undefined,
    n8n: n8n
        ? {
              encryptionKey: n8n.encryptionKey,
              db: n8n.postgresConfig,
          }
        : undefined,
    speaches: speaches
        ? {
              apiUrl: speaches.apiUrl,
              sttModel: speaches.sttModel,
              ttsModel: speaches.ttsModel,
              ttsVoice: speaches.ttsVoice,
          }
        : undefined,
};
