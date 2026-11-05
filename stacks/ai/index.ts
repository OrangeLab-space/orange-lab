import { config, mergeEndpointExports, requireOutput } from '@orangelab/pulumi';
import assert from 'node:assert';
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

// Profiles served over the agent's OpenAI-compatible API as /p/<profile>/v1.
// Each is a provider of its own in the gateway catalog, named after the profile.
const hermesProfiles = config.isEnabled('hermes')
    ? (config.getCommaSeparated('hermes', 'profiles') ?? [])
    : [];
assertHermesProfiles();

const agentgateway = config.isEnabled('agentgateway')
    ? new Agentgateway('agentgateway', {
          // agentgateway is the only client of the agent's API server, so it mints
          // the credential both sides use and hands a copy to `hermes` below.
          generatedProviderKeys: config.isEnabled('hermes')
              ? ['hermes', ...hermesProfiles]
              : [],
      })
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
    ? new Hermes(
          'hermes',
          {
              agentgatewayApiKey: agentgateway?.apiKeys.hermes,
              agentgatewayUrl: agentgateway?.apiUrl,
              apiServerKey: agentgateway?.providerApiKeys.hermes,
              apiServerProfileKeys: Object.fromEntries(
                  hermesProfiles.map(profile => [
                      profile,
                      requireOutput(
                          agentgateway?.providerApiKeys[profile],
                          `hermes:profiles '${profile}' needs agentgateway:enabled.`,
                      ),
                  ]),
              ),
              profiles: hermesProfiles,
              speech: speaches
                  ? {
                        sttModel: speaches.sttModel,
                        ttsModel: speaches.ttsModel,
                        ttsVoice: speaches.ttsVoice,
                        url: speaches.apiUrl,
                    }
                  : undefined,
          },
          { dependsOn: [agentgateway, speaches].filter(x => x !== undefined) },
      )
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
              apiServerKey: hermes.apiServerKey,
              apiUrl: hermes.apiUrl,
              dashboardPassword: hermes.dashboardPassword,
              webhookSecret: hermes.webhookSecret,
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

/**
 * A profile's key is minted for the gateway provider of the same name. An
 * undeclared name still gets a key but no route, so every turn answers 401.
 */
function assertHermesProfiles(): void {
    if (hermesProfiles.length === 0) return;
    assert(
        config.isEnabled('agentgateway'),
        'hermes:profiles needs agentgateway:enabled: every profile is a gateway provider.',
    );
    const declared = Object.keys(
        config.requireObject('agentgateway', 'providers') as Record<string, unknown>,
    );
    for (const profile of hermesProfiles) {
        assert(
            declared.includes(profile),
            `hermes:profiles '${profile}' needs a matching agentgateway:providers.${profile}.`,
        );
    }
}
