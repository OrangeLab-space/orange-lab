import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import type { OidcAuthConfig } from './auth';
import { createTraefikOidcMiddleware } from './oidc-auth';

/** A Traefik middleware, with the name a route references it by. */
export interface TraefikMiddleware {
    name: string;
    resource: kubernetes.apiextensions.CustomResource;
}

const requestHeadersMiddlewareName = (appName: string) => `${appName}-request-headers`;

const routeMiddlewareChainName = (appName: string) => `${appName}-route-middlewares`;

/**
 * The middleware a route attaches: OIDC, request headers, both chained, or
 * none. A route carries one middleware, and the Gateway API does not allow
 * repeating the ExtensionRef filter, so several are chained.
 */
export function createRouteMiddleware(
    args: {
        appName: string;
        namespace: pulumi.Input<string>;
        oidc?: { config: OidcAuthConfig; pluginSecret?: pulumi.Input<string> };
        requestHeaders?: Record<string, string>;
    },
    opts?: { parent?: pulumi.Resource },
): TraefikMiddleware | undefined {
    const middlewares: TraefikMiddleware[] = [];
    if (args.oidc !== undefined) {
        if (args.oidc.pluginSecret === undefined) {
            throw new Error(`${args.appName}: OIDC plugin secret is not configured.`);
        }
        middlewares.push(
            createTraefikOidcMiddleware(
                {
                    appName: args.appName,
                    namespace: args.namespace,
                    oidc: args.oidc.config,
                    pluginSecret: args.oidc.pluginSecret,
                },
                opts,
            ),
        );
    }
    if (
        args.requestHeaders !== undefined &&
        Object.keys(args.requestHeaders).length > 0
    ) {
        middlewares.push(
            createRequestHeadersMiddleware(
                {
                    appName: args.appName,
                    namespace: args.namespace,
                    headers: args.requestHeaders,
                },
                opts,
            ),
        );
    }

    return combineMiddlewares(
        { appName: args.appName, namespace: args.namespace, middlewares },
        opts,
    );
}

/**
 * Traefik middleware that sets request headers for a route. An empty value
 * removes a header the client sent, which is the only way to sanitize one
 * Traefik does not manage itself.
 */
function createRequestHeadersMiddleware(
    args: {
        appName: string;
        namespace: pulumi.Input<string>;
        headers: Record<string, string>;
    },
    opts?: { parent?: pulumi.Resource },
): TraefikMiddleware {
    const name = requestHeadersMiddlewareName(args.appName);
    return {
        name,
        resource: new kubernetes.apiextensions.CustomResource(
            name,
            {
                apiVersion: 'traefik.io/v1alpha1',
                kind: 'Middleware',
                metadata: { name, namespace: args.namespace },
                spec: { headers: { customRequestHeaders: args.headers } },
            },
            opts,
        ),
    };
}

/** The only member, or a chain of all of them. */
function combineMiddlewares(
    args: {
        appName: string;
        namespace: pulumi.Input<string>;
        middlewares: TraefikMiddleware[];
    },
    opts?: { parent?: pulumi.Resource },
): TraefikMiddleware | undefined {
    if (args.middlewares.length === 0) return undefined;
    if (args.middlewares.length === 1) return args.middlewares[0];

    const name = routeMiddlewareChainName(args.appName);
    return {
        name,
        resource: new kubernetes.apiextensions.CustomResource(
            name,
            {
                apiVersion: 'traefik.io/v1alpha1',
                kind: 'Middleware',
                metadata: { name, namespace: args.namespace },
                spec: {
                    chain: {
                        middlewares: args.middlewares.map(m => ({ name: m.name })),
                    },
                },
            },
            { ...opts, dependsOn: args.middlewares.map(m => m.resource) },
        ),
    };
}
