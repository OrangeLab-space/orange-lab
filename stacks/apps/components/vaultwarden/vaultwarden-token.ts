import { config, createPassword, Metadata } from '@orangelab/pulumi';
import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { Argon2Hash } from './argon2-hash';

export class VaultwardenToken extends pulumi.ComponentResource {
    public readonly plainToken: pulumi.Output<string>;
    public readonly secretResource: kubernetes.core.v1.Secret;

    constructor(
        private appName: string,
        private metadata: Metadata,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super('orangelab:apps:VaultwardenToken', `${appName}-token`, {}, opts);
        const plainToken =
            config.getSecret(appName, 'adminToken') ??
            createPassword(this, `${appName}-admin-token`);

        const argon2Hash = new Argon2Hash(`${appName}-admin-hash`, plainToken, {
            parent: this,
        });
        const hashOutput = argon2Hash.hash;

        const secretResource = this.createSecret(plainToken, hashOutput);

        this.plainToken = plainToken;
        this.secretResource = secretResource;
    }

    private createSecret(
        plainToken: pulumi.Output<string>,
        hashOutput: pulumi.Output<string>,
    ) {
        return new kubernetes.core.v1.Secret(
            `${this.appName}-admin-token`,
            {
                metadata: this.metadata.get({ component: 'admin-token' }),
                stringData: pulumi
                    .all([plainToken, hashOutput])
                    .apply(([plain, hash]) => ({
                        ADMIN_TOKEN_PLAIN: plain,
                        ADMIN_TOKEN_HASH: hash,
                    })),
            },
            { parent: this },
        );
    }
}
