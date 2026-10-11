import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

export class Metadata {
    public readonly namespace: pulumi.Output<string>;

    constructor(
        private appName: string,
        args: {
            namespace?: string;
            existingNamespace?: string;
            /** Labels applied to the application namespace. */
            labels?: Record<string, string>;
        },
        opts: pulumi.ComponentResourceOptions,
    ) {
        const namespaceName = args.existingNamespace ?? args.namespace ?? appName;
        const namespaceResource = args.existingNamespace
            ? kubernetes.core.v1.Namespace.get(`${this.appName}-ns`, namespaceName, opts)
            : new kubernetes.core.v1.Namespace(
                  `${this.appName}-ns`,
                  { metadata: { name: namespaceName, labels: args.labels } },
                  opts,
              );
        this.namespace = namespaceResource.metadata.name;
    }

    get(params?: {
        component?: string;
        annotations?: Record<string, pulumi.Input<string> | undefined>;
    }): {
        name: string;
        namespace: pulumi.Input<string>;
        labels: Record<string, string>;
        annotations?: Record<string, pulumi.Input<string>>;
    } {
        return {
            name: params?.component
                ? `${this.appName}-${params.component}`
                : this.appName,
            namespace: this.namespace,
            labels:
                this.removeUndefinedValues(this.getAppLabels(params?.component)) ?? {},
            annotations: this.removeUndefinedValues(params?.annotations),
        };
    }

    private removeUndefinedValues<T>(
        obj: Record<string, T | undefined> | undefined,
    ): Record<string, T> | undefined {
        if (!obj) return undefined;
        const filteredEntries = Object.entries(obj).filter(
            ([, value]) => value !== undefined,
        ) as [string, T][];
        return Object.fromEntries(filteredEntries);
    }

    getSelectorLabels(component?: string) {
        return {
            'app.kubernetes.io/name': this.appName,
            'app.kubernetes.io/component': component ?? 'default',
        };
    }

    getAppLabels(componentName?: string) {
        const labels: Record<string, string | undefined> = {
            'app.kubernetes.io/name': this.appName,
            'app.kubernetes.io/managed-by': 'OrangeLab',
            'app.kubernetes.io/component': componentName ?? 'default',
        };
        return labels;
    }
}
