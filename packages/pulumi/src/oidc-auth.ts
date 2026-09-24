import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { OidcAuthConfig } from './auth';

export const traefikOidcMiddlewareName = (appName: string) => `${appName}-oidc-auth`;
const pluginName = 'traefik-oidc-auth';

interface MiddlewareHeader {
    Name: string;
    Value: pulumi.Input<string>;
}

/**
 * Go template forwarding the authenticated user's claims to the upstream app.
 * The plugin renders these per request; values are only sent to authorized requests.
 */
const identityHeaders: MiddlewareHeader[] = [
    { Name: 'X-Forwarded-User', Value: '{{ .claims.preferred_username }}' },
    {
        Name: 'X-Forwarded-Groups',
        Value: '{{ range $i, $g := .claims.groups }}{{ if $i }},{{ end }}{{ $g }}{{ end }}',
    },
];

export function createTraefikOidcMiddleware(
    args: {
        appName: string;
        namespace: pulumi.Input<string>;
        oidc: OidcAuthConfig;
        pluginSecret: pulumi.Input<string>;
    },
    opts?: {
        parent?: pulumi.Resource;
        dependsOn?: pulumi.Resource[];
    },
): kubernetes.apiextensions.CustomResource {
    const name = traefikOidcMiddlewareName(args.appName);
    const providerUrl = args.oidc.providerBaseUrl;
    if (providerUrl === undefined) {
        throw new Error(`${args.appName}: OIDC provider endpoints are unavailable.`);
    }

    const scopes = ['openid', 'profile', 'email'];
    if (args.oidc.forwardIdentity) {
        // 'groups' scope is required by Pocket ID to include the groups claim.
        scopes.push('groups');
    }
    const headers: MiddlewareHeader[] = [
        ...(args.oidc.forwardIdentity ? identityHeaders : []),
        ...Object.entries(args.oidc.headers ?? {}).map(([headerName, value]) => ({
            Name: headerName,
            Value: value,
        })),
    ];

    const secretName = `${name}-secret`;
    const secret = new kubernetes.core.v1.Secret(
        `${secretName}-secret`,
        {
            metadata: { name: secretName, namespace: args.namespace },
            stringData: {
                clientSecret: args.oidc.clientSecret,
                pluginSecret: args.pluginSecret,
            },
        },
        {
            parent: opts?.parent,
            dependsOn: opts?.dependsOn,
            deleteBeforeReplace: true,
        },
    );

    return new kubernetes.apiextensions.CustomResource(
        name,
        {
            apiVersion: 'traefik.io/v1alpha1',
            kind: 'Middleware',
            metadata: { name, namespace: args.namespace },
            spec: {
                plugin: {
                    [pluginName]: {
                        secret: pulumi.interpolate`urn:k8s:secret:${secret.metadata.name}:pluginSecret`,
                        provider: {
                            url: providerUrl,
                            clientId: args.oidc.clientId,
                            clientSecret: pulumi.interpolate`urn:k8s:secret:${secret.metadata.name}:clientSecret`,
                        },
                        Scopes: scopes,
                        ...(headers.length > 0 ? { Headers: headers } : {}),
                    },
                },
            },
        },
        { parent: opts?.parent, dependsOn: [secret, ...(opts?.dependsOn ?? [])] },
    );
}
