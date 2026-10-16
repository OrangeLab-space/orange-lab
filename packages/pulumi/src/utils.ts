import * as pulumi from '@pulumi/pulumi';

/**
 * Resolves a required `Input` to an `Output`, failing with `message` when the
 * value is absent or resolves empty.
 *
 * Cross-stack values (OIDC endpoints from the core stack) are only known once
 * their Output resolves, so the check runs inside `apply`. A value that is
 * already `undefined` is caught immediately, which surfaces the failure at
 * preview rather than partway through an update.
 */
export function requireOutput(
    value: pulumi.Input<string | undefined>,
    message: string,
): pulumi.Output<string> {
    if (value === undefined) throw new Error(message);

    return pulumi.output(value).apply(resolved => {
        if (!resolved) throw new Error(message);
        return resolved;
    });
}
