import { Application, config } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

const port = 8000;
const storageName = 'cache';

export class Speaches extends pulumi.ComponentResource {
    public readonly apiUrl: pulumi.Output<string>;

    public readonly app: Application;

    public readonly sttModel: string;

    public readonly ttsModel: string;

    public readonly ttsVoice: string;

    constructor(
        private readonly name: string,
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:ai:Speaches', name, {}, opts);

        this.sttModel = config.require(name, 'sttModel');
        this.ttsModel = config.require(name, 'ttsModel');
        this.ttsVoice = config.require(name, 'ttsVoice');

        const gpu = config.get(name, 'gpu');
        if (gpu === 'amd' || gpu === 'intel') {
            throw new Error(
                `${name}: Speaches supports cpu and nvidia only; ${gpu} is not supported.`,
            );
        }

        this.app = new Application(this, name);
        this.app.addLocalStorage({
            name: storageName,
            hostPath: config.require(name, 'storagePath'),
            type: 'DirectoryOrCreate',
        });
        if (this.app.storageOnly) {
            this.apiUrl = pulumi.output('');
            return;
        }

        this.app.addDeployment({
            ports: [{ name: 'http', port, private: true }],
            volumeMounts: [
                {
                    name: storageName,
                    mountPath: '/home/ubuntu/.cache/huggingface/hub',
                },
            ],
            env: {
                ENABLE_UI: 'False',
                PRELOAD_MODELS: JSON.stringify([this.sttModel, this.ttsModel]),
                STT_MODEL_TTL: '-1',
                TTS_MODEL_TTL: '-1',
                ...(gpu === 'nvidia'
                    ? {
                          WHISPER__COMPUTE_TYPE: 'float16',
                          WHISPER__INFERENCE_DEVICE: 'cuda',
                      }
                    : {
                          WHISPER__COMPUTE_TYPE: 'int8',
                          WHISPER__INFERENCE_DEVICE: 'cpu',
                      }),
            },
            healthCheck: { httpGet: { path: '/health' } },
            runAsUser: 1000,
            volumeOwnerUserId: 1000,
            resources: {
                requests: { cpu: '500m', memory: '1Gi' },
                limits: { cpu: '4', memory: '4Gi' },
            },
        });

        this.apiUrl = pulumi.interpolate`http://${this.name}.${this.app.metadata.namespace}.svc.cluster.local:${String(port)}/v1`;
        this.app.network.addClusterEndpoint(this.name, this.apiUrl);
        this.app.network.addClusterEndpoint(
            `${this.name}-stt`,
            pulumi.interpolate`${this.apiUrl}/audio/transcriptions`,
        );
        this.app.network.addClusterEndpoint(
            `${this.name}-tts`,
            pulumi.interpolate`${this.apiUrl}/audio/speech`,
        );
        this.app.network.addClusterEndpoint(
            `${this.name}-voices`,
            pulumi.interpolate`${this.apiUrl}/audio/voices`,
        );
    }
}
