import { config } from '@orangelab/pulumi';
import { Automatic1111 } from './components/automatic1111/automatic1111';
import { InvokeAi } from './components/invokeai/invokeai';
import { KubeAi } from './components/kubeai/kubeai';
import { N8n } from './components/n8n/n8n';
import { Ollama } from './components/ollama/ollama';
import { OpenWebUI } from './components/open-webui/open-webui';
import { SDNext } from './components/sdnext/sdnext';

const ollama = config.isEnabled('ollama') ? new Ollama('ollama') : undefined;

const automatic1111 = config.isEnabled('automatic1111')
    ? new Automatic1111('automatic1111')
    : undefined;

const sdnext = config.isEnabled('sdnext') ? new SDNext('sdnext') : undefined;

const kubeAI = config.isEnabled('kubeai') ? new KubeAi('kubeai') : undefined;

const openWebUI = config.isEnabled('open-webui')
    ? new OpenWebUI(
          'open-webui',
          {
              ollamaUrl: ollama?.serviceUrl,
              openAiUrl: kubeAI?.serviceUrl,
              automatic1111Url:
                  sdnext?.app.network.clusterEndpoints.sdnext ??
                  automatic1111?.app.network.clusterEndpoints.automatic1111,
          },
          {
              dependsOn: [ollama, kubeAI, automatic1111, sdnext].filter(x => x !== undefined),
          },
      )
    : undefined;

const invokeAi = config.isEnabled('invokeai') ? new InvokeAi('invokeai') : undefined;

const n8n = config.isEnabled('n8n')
    ? new N8n('n8n', { ollamaUrl: ollama?.serviceUrl })
    : undefined;

export const endpoints = {
    ...automatic1111?.app.network.endpoints,
    ...invokeAi?.app.network.endpoints,
    kubeai: kubeAI?.endpointUrl,
    ollama: ollama?.endpointUrl,
    'open-webui': openWebUI?.endpointUrl,
    ...sdnext?.app.network.endpoints,
    ...n8n?.app.network.endpoints,
};

export const clusterEndpoints = {
    ...automatic1111?.app.network.clusterEndpoints,
    ...invokeAi?.app.network.clusterEndpoints,
    kubeai: kubeAI?.serviceUrl,
    ollama: ollama?.serviceUrl,
    ...sdnext?.app.network.clusterEndpoints,
    ...n8n?.app.network.clusterEndpoints,
};

export const apps = {
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
};
