import { LocalVolume } from '@orangelab/pulumi';
import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import assert from 'node:assert';
import {
    ModelDefinition,
    ModelGpu,
    ModelNodeSpec,
    nodeResourceProfile,
} from './model-config';

interface ModelVolumeArgs {
    appName: string;
    chart: pulumi.Resource;
    namespace: pulumi.Input<string>;
    nodes: Map<string, ModelNodeSpec>;
    parent: pulumi.Resource;
    storagePath: string;
}

interface ModelLoaderArgs {
    appName: string;
    chart: pulumi.Resource;
    definitions: ModelDefinition[];
    namespace: pulumi.Input<string>;
    nodes: Map<string, ModelNodeSpec>;
    ollamaImages: Partial<Record<ModelGpu, string>>;
    parent: pulumi.Resource;
    storagePath: string;
    tolerations?: kubernetes.types.input.core.v1.Toleration[];
}

interface ModelResourceArgs {
    appName: string;
    chart: pulumi.Resource;
    definitions: ModelDefinition[];
    loaders: Map<string, kubernetes.batch.v1.Job>;
    namespace: pulumi.Input<string>;
    nodes: Map<string, ModelNodeSpec>;
    parent: pulumi.Resource;
    volumes: Map<string, LocalVolume>;
}

const loaderScript = `set -e
ollama serve >/tmp/ollama.log 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT
for i in $(seq 1 60); do
  if ollama list >/dev/null 2>&1; then break; fi
  sleep 2
done
if ! ollama list >/dev/null 2>&1; then cat /tmp/ollama.log; exit 1; fi
for model in "$@"; do
  if ollama show -- "$model" >/dev/null 2>&1; then
    echo "already present: $model"
  else
    ollama pull -- "$model"
  fi
done`;

export function createModelVolumes(args: ModelVolumeArgs): Map<string, LocalVolume> {
    const volumes = new Map<string, LocalVolume>();
    for (const node of args.nodes.values()) {
        volumes.set(
            node.name,
            new LocalVolume(
                `${args.appName}-storage-${node.name}`,
                {
                    affinity: nodeAffinity(node.name),
                    appName: args.appName,
                    claim: true,
                    hostPath: args.storagePath,
                    labels: {},
                    namespace: args.namespace,
                    size: node.storageSize,
                    type: 'DirectoryOrCreate',
                    volumeName: `models-${node.name}`,
                },
                { dependsOn: [args.chart], parent: args.parent },
            ),
        );
    }
    return volumes;
}

export function createModelLoaders(
    args: ModelLoaderArgs,
): Map<string, kubernetes.batch.v1.Job> {
    const sourcesByNode = new Map<string, Set<string>>();
    for (const definition of args.definitions) {
        if (definition.engine !== 'OLlama' || !definition.source) continue;
        const sources = sourcesByNode.get(definition.node) ?? new Set<string>();
        sources.add(definition.source);
        sourcesByNode.set(definition.node, sources);
    }

    const loaders = new Map<string, kubernetes.batch.v1.Job>();
    for (const [node, sources] of sourcesByNode) {
        const spec = args.nodes.get(node);
        assert(spec, `Unknown model node '${node}'.`);
        const image = args.ollamaImages[spec.gpu];
        assert(
            image,
            `${args.appName}:images.ollama.${spec.gpu} is required for Ollama models on '${spec.name}'. Copy the default kubeai:images entries and add your own.`,
        );
        loaders.set(node, createModelLoaderJob(args, spec, sources, image));
    }
    return loaders;
}

function createModelLoaderJob(
    args: ModelLoaderArgs,
    node: ModelNodeSpec,
    sources: Set<string>,
    image: string,
): kubernetes.batch.v1.Job {
    const name = `${args.appName}-model-loader-${node.name}`;
    return new kubernetes.batch.v1.Job(
        name,
        {
            metadata: { name, namespace: args.namespace },
            spec: {
                activeDeadlineSeconds: 7200,
                backoffLimit: 2,
                template: { spec: loaderPodSpec(args, node, sources, image) },
            },
        },
        { deleteBeforeReplace: true, dependsOn: [args.chart], parent: args.parent },
    );
}

function loaderPodSpec(
    args: ModelLoaderArgs,
    node: ModelNodeSpec,
    sources: Set<string>,
    image: string,
): kubernetes.types.input.core.v1.PodSpec {
    return {
        containers: [loaderContainer(sources, image)],
        nodeSelector: { 'kubernetes.io/hostname': node.name },
        restartPolicy: 'Never',
        securityContext: { seLinuxOptions: { type: 'spc_t' } },
        ...(args.tolerations ? { tolerations: args.tolerations } : {}),
        volumes: [
            {
                hostPath: {
                    path: args.storagePath,
                    type: 'DirectoryOrCreate',
                },
                name: 'models',
            },
        ],
    };
}

function loaderContainer(
    sources: Set<string>,
    image: string,
): kubernetes.types.input.core.v1.Container {
    return {
        args: ['-c', loaderScript, 'model-loader', ...sources],
        command: ['/bin/sh'],
        env: [
            { name: 'HOME', value: '/tmp' },
            { name: 'OLLAMA_HOST', value: '127.0.0.1:11434' },
            { name: 'OLLAMA_MODELS', value: '/model' },
        ],
        image,
        name: 'loader',
        resources: { requests: { cpu: '1', memory: '1Gi' } },
        securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
            readOnlyRootFilesystem: false,
            runAsGroup: 0,
            runAsUser: 0,
        },
        volumeMounts: [{ mountPath: '/model', name: 'models' }],
    };
}

export function createModelResources(args: ModelResourceArgs): void {
    for (const definition of args.definitions) {
        createModelResource(args, definition);
    }
}

function createModelResource(args: ModelResourceArgs, definition: ModelDefinition): void {
    const node = getNode(args.nodes, definition.node);
    const { dependsOn, url } = modelDependencies(args, definition);
    new kubernetes.apiextensions.CustomResource(
        `${args.appName}-model-${definition.name}`,
        {
            apiVersion: 'kubeai.org/v1',
            kind: 'Model',
            metadata: { name: definition.name, namespace: args.namespace },
            spec: modelSpec(definition, node, url),
        },
        { dependsOn, parent: args.parent },
    );
}

function getNode(nodes: Map<string, ModelNodeSpec>, name: string): ModelNodeSpec {
    const node = nodes.get(name);
    assert(node, `Unknown model node '${name}'.`);
    return node;
}

function modelDependencies(
    args: ModelResourceArgs,
    definition: ModelDefinition,
): { dependsOn: pulumi.Resource[]; url: pulumi.Input<string> } {
    const dependsOn: pulumi.Resource[] = [args.chart];
    if (definition.engine !== 'OLlama') {
        // shortcut: non-Ollama pvc:// URLs get no claim dependency; add one if used.
        assert(definition.url, `Missing model URL for '${definition.name}'.`);
        return { dependsOn, url: definition.url };
    }

    const volume = args.volumes.get(definition.node);
    assert(volume, `Missing model volume for node '${definition.node}'.`);
    const claimName = volume.volumeClaimName;
    assert(claimName, `Missing model volume claim for node '${definition.node}'.`);
    dependsOn.push(volume);
    const loader = args.loaders.get(definition.node);
    if (loader) dependsOn.push(loader);
    return {
        dependsOn,
        url: pulumi.interpolate`pvc://${claimName}?model=${
            definition.source ?? ''
        }&pull=false`,
    };
}

function modelSpec(
    definition: ModelDefinition,
    node: ModelNodeSpec,
    url: pulumi.Input<string>,
): Record<string, unknown> {
    const isOllama = definition.engine === 'OLlama';
    return {
        ...(definition.args ? { args: definition.args } : {}),
        engine: definition.engine,
        env: {
            ...node.env,
            ...(isOllama
                ? {
                      OLLAMA_CONTEXT_LENGTH: '8192',
                      OLLAMA_IGPU_ENABLE: '1',
                  }
                : {}),
        },
        features: ['TextGeneration'],
        ...(definition.image ? { image: definition.image } : {}),
        maxReplicas: 1,
        minReplicas: definition.minReplicas ?? 1,
        resourceProfile: `${nodeResourceProfile(node)}:1`,
        url,
    };
}

function nodeAffinity(node: string): kubernetes.types.input.core.v1.VolumeNodeAffinity {
    return {
        required: {
            nodeSelectorTerms: [
                {
                    matchExpressions: [
                        {
                            key: 'kubernetes.io/hostname',
                            operator: 'In',
                            values: [node],
                        },
                    ],
                },
            ],
        },
    };
}
