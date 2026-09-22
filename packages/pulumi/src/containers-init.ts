import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { Metadata } from './metadata';
import { Storage, resolveVolumeName } from './storage';
import { ContainerSpec, InitContainerSpec, VolumeMount } from './types';
import { config } from './config';

export class InitContainers {
    constructor(
        private appName: string,
        private args: {
            metadata: Metadata;
            storage?: Storage;
        },
        private opts?: pulumi.ComponentResourceOptions,
    ) {}

    public create(
        spec: ContainerSpec,
    ): pulumi.Input<pulumi.Input<kubernetes.types.input.core.v1.Container>[]> {
        const initContainers = spec.initContainers ?? [];

        const mountPaths = this.getLocalVolumeMounts(spec.volumeMounts);
        if (spec.volumeOwnerUserId && mountPaths.length > 0) {
            initContainers.push(
                this.createPermissionsContainer(spec.volumeOwnerUserId, mountPaths),
            );
        }

        return initContainers.map(initContainer => ({
            name: initContainer.name,
            image: initContainer.image ?? 'busybox:latest',
            command: initContainer.command,
            imagePullPolicy: 'IfNotPresent',
            securityContext: this.createSecurityContext(),
            volumeMounts: this.createVolumeMounts(
                initContainer.volumeMounts ?? spec.volumeMounts,
            ),
        }));
    }

    /**
     * Volume names referenced by init containers, so the pod can declare
     * volumes that only an init container mounts.
     */
    public getVolumeNames(spec: ContainerSpec): string[] {
        const names = new Set<string>();
        for (const initContainer of spec.initContainers ?? []) {
            for (const mount of initContainer.volumeMounts ?? spec.volumeMounts ?? []) {
                names.add(resolveVolumeName(this.appName, mount.name));
            }
        }
        return [...names];
    }

    private createPermissionsContainer(
        runAsUser: number,
        mountPaths: string[],
    ): InitContainerSpec {
        const userId = String(runAsUser);
        const paths = mountPaths.join(' ');
        const options = config.get(this.appName, 'fixVolumePermissions') ?? '';
        const args = [options, `${userId}:${userId}`, paths].filter(Boolean).join(' ');
        return {
            name: 'fix-volume-permissions',
            command: ['sh', '-c', `chown ${args}`],
        };
    }

    private getLocalVolumeMounts(volumeMounts?: VolumeMount[]): string[] {
        const volumeNames = this.args.storage?.getVolumeNames() ?? [this.appName];
        return (volumeMounts ?? [])
            .filter(
                mount =>
                    !mount.readOnly &&
                        volumeNames.includes(resolveVolumeName(this.appName, mount.name)),
            )
            .map(mount => mount.mountPath);
    }

    private createSecurityContext():
        | kubernetes.types.input.core.v1.SecurityContext
        | undefined {
        return this.args.storage?.hasLocal() ? { privileged: true } : undefined;
    }

    private createVolumeMounts(
        volumeMounts?: VolumeMount[],
    ): kubernetes.types.input.core.v1.VolumeMount[] | undefined {
        const mounts = (volumeMounts ?? []).map(volumeMount => ({
            ...volumeMount,
            ...{ name: resolveVolumeName(this.appName, volumeMount.name) },
        }));
        return mounts;
    }
}
