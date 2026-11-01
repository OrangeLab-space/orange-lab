import * as kubernetes from '@pulumi/kubernetes';
import assert from 'node:assert';
import { config } from './config';
import { GpuType } from './types';

type NodeSelectorRequirement = kubernetes.types.input.core.v1.NodeSelectorRequirement;
type NodeSelectorTerm = kubernetes.types.input.core.v1.NodeSelectorTerm;

export interface NodesArgs {
    appName: string;
}

export class Nodes {
    constructor(private args: NodesArgs) {}

    getGpu(component?: string): GpuType | undefined {
        const gpu = component
            ? config.get(this.args.appName, `${component}/gpu`)
            : config.get(this.args.appName, 'gpu');
        return gpu as GpuType | undefined;
    }

    getTolerations(
        component?: string,
    ): kubernetes.types.input.core.v1.Toleration[] | undefined {
        const prefix = component ? `${component}/` : '';
        const spec =
            config.get(this.args.appName, `${prefix}tolerations`) ??
            config.get(this.args.appName, 'tolerations');
        return spec ? this.parseTolerations(spec) : undefined;
    }

    getAffinity(component?: string): kubernetes.types.input.core.v1.Affinity | undefined {
        const prefix = component ? `${component}/` : '';
        const preferredNodeLabel =
            config.get(this.args.appName, `${prefix}preferredNodeLabel`) ??
            config.get(this.args.appName, 'preferredNodeLabel');
        const requiredNodeLabel =
            config.get(this.args.appName, `${prefix}requiredNodeLabel`) ??
            config.get(this.args.appName, 'requiredNodeLabel');
        const excludeNodeLabel =
            config.get(this.args.appName, `${prefix}excludeNodeLabel`) ??
            config.get(this.args.appName, 'excludeNodeLabel');
        const requiredTerms = this.getRequiredNodeSelectorTerms(
            requiredNodeLabel,
            excludeNodeLabel,
            component,
        );

        if (requiredTerms.length === 0 && !preferredNodeLabel) return;

        return {
            nodeAffinity: {
                requiredDuringSchedulingIgnoredDuringExecution:
                    requiredTerms.length > 0
                        ? { nodeSelectorTerms: requiredTerms }
                        : undefined,
                preferredDuringSchedulingIgnoredDuringExecution: preferredNodeLabel
                    ? [
                          {
                              preference: this.getNodeSelectorTerm(preferredNodeLabel),
                              weight: 1,
                          },
                      ]
                    : undefined,
            },
        };
    }

    private parseTolerations(
        spec: string,
    ): kubernetes.types.input.core.v1.Toleration[] {
        return spec
            .split(',')
            .map(entry => entry.trim())
            .filter(Boolean)
            .map(entry => {
                const [keyValue, effect] = entry.split(':');
                const [key, value] = keyValue.split('=');
                assert(key, `Invalid toleration '${entry}': missing key.`);
                assert(
                    !effect ||
                        ['NoSchedule', 'PreferNoSchedule', 'NoExecute'].includes(effect),
                    `Invalid toleration '${entry}': invalid effect '${effect}'.`,
                );
                return {
                    effect,
                    key,
                    operator: value ? 'Equal' : 'Exists',
                    value,
                };
            });
    }

    getVolumeAffinity(
        component?: string,
    ): kubernetes.types.input.core.v1.VolumeNodeAffinity | undefined {
        const requiredVolumeLabel = config.get(
            this.args.appName,
            `${component ? `${component}/` : ''}requiredVolumeLabel`,
        );
        return requiredVolumeLabel
            ? {
                  required: {
                      nodeSelectorTerms: [this.getNodeSelectorTerm(requiredVolumeLabel)],
                  },
              }
            : undefined;
    }

    getLocalVolumeAffinity(): kubernetes.types.input.core.v1.VolumeNodeAffinity {
        const requiredNodeLabel = config.require(this.args.appName, 'requiredNodeLabel');
        return {
            required: {
                nodeSelectorTerms: [this.getNodeSelectorTerm(requiredNodeLabel)],
            },
        };
    }

    private getRequiredNodeSelectorTerms(
        requiredNodeLabel?: string,
        excludeNodeLabel?: string,
        component?: string,
    ): NodeSelectorTerm[] {
        const matchExpressions: NodeSelectorRequirement[] = [];

        if (requiredNodeLabel) {
            matchExpressions.push(...this.getNodeSelectorRequirements(requiredNodeLabel));
        } else {
            const gpu = this.getGpu(component);
            if (gpu === 'amd') {
                matchExpressions.push(
                    ...this.getNodeSelectorRequirements('orangelab/gpu-amd=true'),
                );
            }
            if (gpu === 'nvidia') {
                matchExpressions.push(
                    ...this.getNodeSelectorRequirements('orangelab/gpu-nvidia=true'),
                );
            }
            if (gpu === 'intel') {
                matchExpressions.push(
                    ...this.getNodeSelectorRequirements('orangelab/gpu-intel=true'),
                );
            }
        }

        if (excludeNodeLabel) {
            matchExpressions.push(
                ...this.getExclusionNodeSelectorRequirements(excludeNodeLabel),
            );
        }

        return matchExpressions.length > 0 ? [{ matchExpressions }] : [];
    }

    /**
     * Creates a NodeSelectorTerm from a label specification string.
     *
     * Format: key=value1|value2|value3
     *
     * Examples:
     * - "topology.kubernetes.io/zone=zone1|zone2" - matches nodes with label set to either "zone1" or "zone2"
     * - "orangelab/gpu-nvidia" - matches nodes that have the label (any value)
     *
     * @param labelSpec - Label specification in format "key", "key=value" or "key=value1|value2"
     * @returns NodeSelectorTerm with appropriate matchExpressions
     */
    private getNodeSelectorTerm(labelSpec: string): NodeSelectorTerm {
        return { matchExpressions: this.getNodeSelectorRequirements(labelSpec) };
    }

    private getNodeSelectorRequirements(labelSpec: string): NodeSelectorRequirement[] {
        const [key, value] = labelSpec.split('=');
        if (!value) {
            return [{ key, operator: 'Exists' }];
        }
        return [
            {
                key,
                operator: 'In',
                values: value.split('|'),
            },
        ];
    }

    private getExclusionNodeSelectorRequirements(
        labelSpec: string,
    ): NodeSelectorRequirement[] {
        const [key, value] = labelSpec.split('=');
        if (!value) {
            return [{ key, operator: 'DoesNotExist' }];
        }
        return [
            {
                key,
                operator: 'NotIn',
                values: value.split('|'),
            },
        ];
    }
}
