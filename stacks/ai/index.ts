import { config, mergeEndpointExports } from '@orangelab/pulumi';
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

export const endpoints = mergeEndpointExports(
    automatic1111,
    invokeAi,
    kubeAI,
    ollama,
    openWebUI,
    sdnext,
    n8n,
);

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
