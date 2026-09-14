import { Application, config } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

export class InvokeAi extends pulumi.ComponentResource {
    app: Application;

    constructor(name: string, opts?: pulumi.ResourceOptions) {
        super('orangelab:ai:InvokeAi', name, {}, opts);

        const huggingfaceToken = config.getSecret(name, 'huggingfaceToken');

        this.app = new Application(this, name).addStorage();

        this.app.addDeployment({
            ports: [{ name: 'http', port: 9090 }],
            env: {
                INVOKEAI_ROOT: '/invokeai',
                INVOKEAI_HOST: '0.0.0.0',
                INVOKEAI_PORT: '9090',
                INVOKEAI_ENABLE_PARTIAL_LOADING: 'true',
                INVOKEAI_LOG_LEVEL: this.app.debug ? 'debug' : 'info',
                INVOKEAI_REMOTE_API_TOKENS: huggingfaceToken
                    ? pulumi.interpolate`[{"url_regex":"huggingface.co", "token": "${huggingfaceToken}"}]`
                    : undefined,
            },
            healthCheck: { httpGet: { path: '/health' } },
            volumeMounts: [{ mountPath: '/invokeai' }],
            resources: { requests: { cpu: '50m', memory: '1.5Gi' } },
        });
    }
}
