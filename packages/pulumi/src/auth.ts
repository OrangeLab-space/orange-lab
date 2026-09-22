import * as pulumi from '@pulumi/pulumi';
import { config } from './config';
import { coreStack } from './core-stack';

export const OidcProvider = {
    Pocket: 'pocket',
} as const;

export interface OidcAuthConfig {
    providerBaseUrl?: pulumi.Input<string | undefined>;
    providerName?: string;
    providerUrl?: pulumi.Input<string | undefined>;
    clientId: string;
    /** Empty for public (PKCE) clients. */
    clientSecret: pulumi.Output<string>;
    /** Forwards the authenticated identity to the upstream app as proxy headers. */
    forwardIdentity?: boolean;
    /** Additional static headers to send to the upstream app (e.g. a proxy secret). */
    headers?: Record<string, pulumi.Input<string>>;
}

export interface OidcProviderSettings {
    providerBaseUrl?: pulumi.Input<string | undefined>;
    providerName?: string;
    providerUrl?: pulumi.Input<string | undefined>;
    /** Enables the shared Traefik middleware for applications without native OIDC. */
    protectRoutes?: boolean;
    /** Registers the application as a public (PKCE) client; no client secret is required. */
    publicClient?: boolean;
    /** Forwards the authenticated username and groups to the upstream app as proxy headers. */
    forwardIdentity?: boolean;
    /** Additional static headers to send to the upstream app (e.g. a proxy secret). */
    headers?: Record<string, pulumi.Input<string>>;
}

export class Auth {
    constructor(private readonly appName: string) {}

    getOidc(local?: OidcProviderSettings): OidcAuthConfig | undefined {
        const provider = config.get(this.appName, 'auth');
        if (provider === undefined) return undefined;
        if (provider !== OidcProvider.Pocket) {
            throw new Error(
                `${this.appName}: unsupported OIDC provider '${provider}'. Supported providers: ${OidcProvider.Pocket}.`,
            );
        }

        return {
            providerBaseUrl:
                local?.providerBaseUrl ??
                coreStack.outputs.security?.apply(
                    security => security?.oidcProviderBaseUrl,
                ),
            providerUrl:
                config.get(this.appName, 'auth/providerUrl') ??
                local?.providerUrl ??
                coreStack.outputs.security?.apply(security => security?.oidcProviderUrl),
            providerName:
                config.get(this.appName, 'auth/providerName') ?? local?.providerName,
            clientId: config.require(this.appName, 'auth/clientId'),
            clientSecret: local?.publicClient
                ? pulumi.output('')
                : config.requireSecret(this.appName, 'auth/clientSecret'),
            forwardIdentity: local?.forwardIdentity,
            headers: local?.headers,
        };
    }
}
