import * as argon2 from 'argon2';
import * as pulumi from '@pulumi/pulumi';

interface Argon2HashInputs {
    password: string;
    hash: string;
}

interface Argon2HashOutputs {
    hash: string;
    password: string;
}

class Argon2HashProvider implements pulumi.dynamic.ResourceProvider {
    create(inputs: Argon2HashInputs): Promise<pulumi.dynamic.CreateResult> {
        // Just store the pre-computed hash - no native code here
        return Promise.resolve({
            id: inputs.hash,
            outs: { hash: inputs.hash, password: inputs.password },
        });
    }

    diff(
        _id: string,
        olds: Argon2HashOutputs,
        news: Argon2HashInputs,
    ): Promise<pulumi.dynamic.DiffResult> {
        const changes = olds.password !== news.password;

        return Promise.resolve({
            changes,
            replaces: changes ? ['password'] : undefined,
        });
    }

    update(
        _id: string,
        _olds: Argon2HashOutputs,
        news: Argon2HashInputs,
    ): Promise<pulumi.dynamic.UpdateResult> {
        // Just store the new pre-computed hash
        return Promise.resolve({ outs: { hash: news.hash, password: news.password } });
    }

    async delete(): Promise<void> {
        // Nothing to clean up
    }
}

export class Argon2Hash extends pulumi.dynamic.Resource {
    // Assigned by the base resource after construction; `declare` keeps the
    // class field from clearing it.
    declare public readonly hash: pulumi.Output<string>;

    constructor(
        name: string,
        password: pulumi.Input<string>,
        opts?: pulumi.CustomResourceOptions,
    ) {
        // Generate hash in the main process (where native code works),
        // then pass it to the dynamic provider for storage
        const hashOutput = pulumi.output(password).apply(async plain => {
            // Use vaultwarden-compatible defaults: m=65536 (64MB), t=3, p=4
            return await argon2.hash(plain, {
                type: argon2.argon2id,
                memoryCost: 65536,
                timeCost: 3,
                parallelism: 4,
                hashLength: 32,
            });
        });

        // Create the resource with both password and pre-computed hash
        super(
            new Argon2HashProvider(),
            name,
            {
                hash: hashOutput,
                password,
            },
            opts,
        );
    }
}
