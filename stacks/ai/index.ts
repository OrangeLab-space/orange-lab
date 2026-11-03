import { config, mergeEndpointExports } from '@orangelab/pulumi';
import { Agentgateway } from './components/agentgateway/agentgateway';
import { ComfyUI } from './components/comfyui/comfyui';
import { Hermes } from './components/hermes/hermes';
import { InvokeAi } from './components/invokeai/invokeai';
import { KubeAi } from './components/kubeai/kubeai';
import { N8n } from './components/n8n/n8n';
import { Ollama } from './components/ollama/ollama';
import { ImageGenerationConnection, OpenWebUI } from './components/open-webui/open-webui';
import { Speaches } from './components/speaches/speaches';

const ollama = config.isEnabled('ollama') ? new Ollama('ollama') : undefined;

const speaches = config.isEnabled('speaches') ? new Speaches('speaches') : undefined;

const agentgateway = config.isEnabled('agentgateway')
    ? new Agentgateway('agentgateway')
    : undefined;

const comfyui = config.isEnabled('comfyui') ? new ComfyUI('comfyui') : undefined;

function getImageGeneration(): ImageGenerationConnection | undefined {
    if (!comfyui) return undefined;
    return {
        model: comfyui.model,
        url: comfyui.app.network.clusterEndpoints.comfyui,
    };
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
              dependsOn: [agentgateway, ollama, speaches, comfyui].filter(
                  x => x !== undefined,
              ),
          },
      )
    : undefined;

const invokeAi = config.isEnabled('invokeai') ? new InvokeAi('invokeai') : undefined;

const n8n = config.isEnabled('n8n')
    ? new N8n('n8n', { ollamaUrl: ollama?.serviceUrl })
    : undefined;

const hermes = config.isEnabled('hermes')
    ? new Hermes('hermes', {
          agentgatewayApiKey: agentgateway?.apiKeys.hermes,
          agentgatewayUrl: agentgateway?.apiUrl,
      })
    : undefined;

export const endpoints = mergeEndpointExports(
    agentgateway,
    comfyui,
    hermes,
    invokeAi,
    kubeAI,
    ollama,
    openWebUI,
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
    hermes: hermes
        ? {
              dashboardPassword: hermes.dashboardPassword,
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
