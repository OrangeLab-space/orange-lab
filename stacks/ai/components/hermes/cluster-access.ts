import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

/**
 * Kubeconfig for the pod's own ServiceAccount. The projected token is re-read on
 * every request and rotated by the kubelet, so nothing secret is stored in Pulumi
 * state or in the ConfigMap.
 */
const kubeconfig = `apiVersion: v1
kind: Config
clusters:
  - name: in-cluster
    cluster:
      server: https://kubernetes.default.svc
      certificate-authority: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
users:
  - name: hermes
    user:
      tokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
contexts:
  - name: in-cluster
    context:
      cluster: in-cluster
      user: hermes
current-context: in-cluster
`;

const read = ['get', 'list', 'watch'];

/**
 * Read-only cluster visibility: enough to inspect and diagnose every workload
 * without being able to change anything. Secrets, exec and pod creation are
 * deliberately absent, so the agent can neither read credentials nor reach a
 * node. Widen this role when unattended changes are wanted.
 */
const rules: kubernetes.types.input.rbac.v1.PolicyRule[] = [
    {
        apiGroups: [''],
        resources: [
            'configmaps',
            'endpoints',
            'events',
            'limitranges',
            'namespaces',
            'nodes',
            'persistentvolumeclaims',
            'pods',
            'pods/log',
            'replicationcontrollers',
            'resourcequotas',
            'serviceaccounts',
            'services',
        ],
        verbs: read,
    },
    {
        apiGroups: ['apps'],
        resources: [
            'controllerrevisions',
            'daemonsets',
            'deployments',
            'replicasets',
            'statefulsets',
        ],
        verbs: read,
    },
    { apiGroups: ['batch'], resources: ['cronjobs', 'jobs'], verbs: read },
    {
        apiGroups: ['autoscaling'],
        resources: ['horizontalpodautoscalers'],
        verbs: read,
    },
    {
        apiGroups: ['networking.k8s.io'],
        resources: ['ingressclasses', 'ingresses', 'networkpolicies'],
        verbs: read,
    },
    {
        apiGroups: ['discovery.k8s.io'],
        resources: ['endpointslices'],
        verbs: read,
    },
    {
        apiGroups: ['gateway.networking.k8s.io'],
        resources: [
            'gatewayclasses',
            'gateways',
            'grpcroutes',
            'httproutes',
            'tlsroutes',
        ],
        verbs: read,
    },
    {
        apiGroups: ['storage.k8s.io'],
        resources: ['csidrivers', 'csinodes', 'storageclasses', 'volumeattachments'],
        verbs: read,
    },
    {
        apiGroups: ['apiextensions.k8s.io'],
        resources: ['customresourcedefinitions'],
        verbs: read,
    },
    {
        apiGroups: ['metrics.k8s.io'],
        resources: ['nodes', 'pods'],
        verbs: ['get', 'list'],
    },
    {
        apiGroups: ['longhorn.io'],
        resources: [
            'backups',
            'backupvolumes',
            'engines',
            'instancemanagers',
            'nodes',
            'replicas',
            'settings',
            'snapshots',
            'volumes',
        ],
        verbs: read,
    },
    {
        apiGroups: ['traefik.io'],
        resources: [
            'ingressroutes',
            'ingressroutetcps',
            'middlewares',
            'serverstransports',
            'tlsoptions',
            'tlsstores',
        ],
        verbs: read,
    },
    {
        apiGroups: ['cert-manager.io'],
        resources: [
            'certificaterequests',
            'certificates',
            'challenges',
            'clusterissuers',
            'issuers',
            'orders',
        ],
        verbs: read,
    },
    {
        apiGroups: ['policy'],
        resources: ['poddisruptionbudgets'],
        verbs: read,
    },
    {
        apiGroups: ['rbac.authorization.k8s.io'],
        resources: ['clusterrolebindings', 'clusterroles', 'rolebindings', 'roles'],
        verbs: read,
    },
];

export class ClusterAccess extends pulumi.ComponentResource {
    public readonly serviceAccount: kubernetes.core.v1.ServiceAccount;
    public readonly kubeconfig = kubeconfig;

    constructor(
        name: string,
        args: { namespace: pulumi.Input<string> },
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:ai:HermesClusterAccess', name, {}, opts);

        const roleName = `${name}-agent`;
        this.serviceAccount = new kubernetes.core.v1.ServiceAccount(
            `${name}-sa`,
            { metadata: { name, namespace: args.namespace } },
            { parent: this },
        );
        const role = new kubernetes.rbac.v1.ClusterRole(
            roleName,
            { metadata: { name: roleName }, rules },
            { parent: this },
        );
        new kubernetes.rbac.v1.ClusterRoleBinding(
            roleName,
            {
                metadata: { name: roleName },
                roleRef: {
                    apiGroup: 'rbac.authorization.k8s.io',
                    kind: 'ClusterRole',
                    name: role.metadata.name,
                },
                subjects: [{ kind: 'ServiceAccount', name, namespace: args.namespace }],
            },
            { parent: this },
        );
    }
}
