import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';

/**
 * Generates a sensitive random password parented to `scope`.
 *
 * `name` becomes the Pulumi logical resource name and must stay stable for a
 * given password; changing it (or `scope`) recreates the resource and rotates
 * the value.
 */
export function createPassword(
    scope: pulumi.Resource,
    name: string,
    args?: { length?: number },
): pulumi.Output<string> {
    return new random.RandomPassword(
        name,
        { length: args?.length ?? 32, special: false },
        { parent: scope },
    ).result;
}
