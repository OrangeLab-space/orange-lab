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
    clientSecret: pulumi.Output<string>;
}

export interface OidcProviderSettings {
    providerBaseUrl?: pulumi.Input<string | undefined>;
    providerName?: string;
    providerUrl?: pulumi.Input<string | undefined>;
    /** Enables the shared Traefik middleware for applications without native OIDC. */
    protectRoutes?: boolean;
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
            clientSecret: config.requireSecret(this.appName, 'auth/clientSecret'),
        };
    }
}
