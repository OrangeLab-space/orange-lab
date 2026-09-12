import * as kubernetes from '@pulumi/kubernetes';
import { config } from './config';
import { GpuType } from './types';

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
        const terms: NodeSelectorTerm[] = [];

        if (requiredNodeLabel) {
            terms.push(this.getNodeSelectorTerm(requiredNodeLabel));
        } else {
            const gpu = this.getGpu(component);
            if (gpu === 'amd') {
                terms.push(this.getNodeSelectorTerm('orangelab/gpu-amd=true'));
            }
            if (gpu === 'nvidia') {
                terms.push(this.getNodeSelectorTerm('orangelab/gpu-nvidia=true'));
            }
        }

        if (excludeNodeLabel) {
            terms.push(this.getExclusionNodeSelectorTerm(excludeNodeLabel));
        }

        return terms;
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
        const [key, value] = labelSpec.split('=');
        if (!value) {
            return { matchExpressions: [{ key, operator: 'Exists' }] };
        }
        return {
            matchExpressions: [
                {
                    key,
                    operator: 'In',
                    values: value.split('|'),
                },
            ],
        };
    }

    private getExclusionNodeSelectorTerm(labelSpec: string): NodeSelectorTerm {
        const [key, value] = labelSpec.split('=');
        if (!value) {
            return { matchExpressions: [{ key, operator: 'DoesNotExist' }] };
        }
        return {
            matchExpressions: [
                {
                    key,
                    operator: 'NotIn',
                    values: value.split('|'),
                },
            ],
        };
    }
}
