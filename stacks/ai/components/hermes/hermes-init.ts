import { InitContainerSpec } from '@orangelab/pulumi';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HermesInitArgs {
    dataPath: string;
    ghVersion: string;
    /** The app image: the only interpreter here that can parse the route file. */
    image: string;
    kubectlVersion: string;
    recreateConfig: boolean;
    runtimeUserId: number;
    seedPath: string;
}

/**
 * Init containers for the Hermes pod: seed the writable profile files and
 * install the pinned command-line tools into the data volume. The scripts live
 * in `init/` beside this one — shell for the `alpine` steps, Python where a step
 * has to parse JSON — and values reach them as environment variables.
 */
export class HermesInit {
    constructor(private readonly args: HermesInitArgs) {}

    /**
     * Copies the seeded profile files into the writable volume when they are
     * missing, so upgrades never overwrite what the agent or the dashboard wrote.
     */
    seed(): InitContainerSpec {
        const { dataPath, recreateConfig, runtimeUserId, seedPath } = this.args;
        return {
            name: 'seed-profile',
            image: 'alpine:3.24',
            command: ['sh', '-c', readScript('seed-profile.sh')],
            env: {
                DATA_PATH: dataPath,
                RECREATE_CONFIG: String(recreateConfig),
                SEED_PATH: seedPath,
                USER_ID: String(runtimeUserId),
            },
            volumeMounts: [
                { mountPath: dataPath },
                { name: 'config', mountPath: seedPath, readOnly: true },
            ],
        };
    }

    /**
     * Merges the seeded webhook routes into the volume. A route is the deploy's
     * to declare, so it has to reach an existing install on a plain `pulumi up` —
     * copying the file only when it is missing leaves an old route answering
     * forever. Routes the seed does not name survive untouched, and an unreadable
     * file is kept beside the seeded one. `alpine` has no JSON parser, so this
     * step runs in the app image.
     */
    seedRoutes(): InitContainerSpec {
        const { dataPath, image, recreateConfig, runtimeUserId, seedPath } = this.args;
        return {
            name: 'seed-routes',
            image,
            command: [
                '/opt/hermes/.venv/bin/python3',
                '-c',
                readScript('seed-routes.py'),
            ],
            env: {
                DATA_PATH: dataPath,
                RECREATE_CONFIG: String(recreateConfig),
                SEED_PATH: seedPath,
                USER_ID: String(runtimeUserId),
            },
            volumeMounts: [
                { mountPath: dataPath },
                { name: 'config', mountPath: seedPath, readOnly: true },
            ],
        };
    }

    /** `kubectl` is not in the image; it lands in the profile's bin directory on PATH. */
    kubectl(): InitContainerSpec {
        const { dataPath, kubectlVersion, runtimeUserId } = this.args;
        return {
            name: 'install-kubectl',
            image: 'alpine:3.24',
            command: ['sh', '-c', readScript('install-kubectl.sh')],
            env: {
                DATA_PATH: dataPath,
                KUBECTL_VERSION: kubectlVersion,
                USER_ID: String(runtimeUserId),
            },
            volumeMounts: [{ mountPath: dataPath }],
        };
    }

    /** `gh` is not in the image either; the token comes from `.env` (see `seed`). */
    gh(): InitContainerSpec {
        const { dataPath, ghVersion, runtimeUserId } = this.args;
        return {
            name: 'install-gh',
            image: 'alpine:3.24',
            command: ['sh', '-c', readScript('install-gh.sh')],
            env: {
                DATA_PATH: dataPath,
                GH_VERSION: ghVersion,
                USER_ID: String(runtimeUserId),
            },
            volumeMounts: [{ mountPath: dataPath }],
        };
    }
}

/** Scripts sit in `init/` beside the TypeScript source, so `pulumi up` runs from here. */
function readScript(name: string): string {
    return readFileSync(join(__dirname, 'init', name), 'utf8');
}
