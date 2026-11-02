import { Application, config, InitContainerSpec } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';
import { ComfyUIFile, ComfyUIModelFile, loadComfyUIModelFile } from './model-file';

export class ComfyUI extends pulumi.ComponentResource {
    app: Application;

    /** Model bundle Open WebUI runs, from `comfyui:modelFile`. */
    readonly model?: ComfyUIModelFile;

    constructor(
        private readonly name: string,
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:ai:ComfyUI', name, {}, opts);

        config.assertNotConfigured(
            name,
            'models',
            `${name}:models moved into the model file. Use ${name}:modelFile instead.`,
        );
        const modelFile = config.require(name, 'modelFile');
        this.model = modelFile ? loadComfyUIModelFile(modelFile) : undefined;

        this.app = new Application(this, name);
        this.app.addLocalStorage({
            name: 'models',
            hostPath: config.require(name, 'storagePath'),
            type: 'DirectoryOrCreate',
        });

        if (this.app.storageOnly) return;

        this.app.addDeployment({
            ports: [{ name: 'http', port: 8188 }],
            env: { CLI_ARGS: this.getCliArgs() },
            initContainers: this.getInitContainers(),
            volumeMounts: [{ name: 'models', mountPath: '/data' }],
            healthCheck: { httpGet: { path: '/system_stats' } },
            resources: { requests: { cpu: '100m', memory: '2Gi' } },
        });
    }

    /**
     * Keeps models, custom nodes, outputs and user settings in the volume while
     * ComfyUI itself keeps coming from the image, so image updates are not
     * frozen at first start. The image already listens on all addresses.
     */
    private getCliArgs(): string {
        const cliArgs = config.get(this.name, 'cliArgs');
        return [`--base-directory /data`, cliArgs].filter(Boolean).join(' ');
    }

    private getInitContainers(): InitContainerSpec[] {
        return [
            {
                name: 'prepare-storage',
                image: 'alpine:3.24',
                command: ['sh', '-c', this.getInitScript(this.model?.files ?? [])],
            },
        ];
    }

    /**
     * ComfyUI lists custom_nodes on startup and fails when it is missing, so the
     * directory is created even without model files. A failed download only
     * warns: ComfyUI must still start so the UI can be used to fix it.
     */
    private getInitScript(files: ComfyUIFile[]): string {
        const lines = ['set -eu', `mkdir -p /data/custom_nodes`];
        for (const file of files) {
            const target = `/data/${file.path}`;
            lines.push(
                `file="${target}"`,
                'mkdir -p "$(dirname "$file")"',
                'if [ -f "$file" ]; then',
                `    echo "Model already present: ${target}"`,
                'else',
                `    echo "Downloading ${target}..."`,
                `    if wget -q -O "$file.part" "${file.url}"; then`,
                '        mv "$file.part" "$file"',
                '    else',
                `        echo "WARNING: download failed: ${target}" >&2`,
                '        rm -f "$file.part"',
                '    fi',
                'fi',
            );
        }
        return lines.join('\n');
    }
}
