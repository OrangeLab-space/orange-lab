import { config, createPassword, Metadata, S3Provisioner } from '@orangelab/pulumi';
import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

export interface RustfsProvisionerArgs {
    appName: string;
    metadata: Metadata;
    rootUser: pulumi.Input<string>;
    rootPassword: pulumi.Input<string>;
    s3EndpointUrl: pulumi.Input<string>;
}

export class RustfsProvisioner extends pulumi.ComponentResource implements S3Provisioner {
    instanceName: string;

    constructor(
        private readonly name: string,
        private readonly args: RustfsProvisionerArgs,
        opts?: pulumi.ResourceOptions,
    ) {
        super('orangelab:RustfsProvisioner', name, args, opts);
        this.instanceName = args.metadata.get().name;
    }

    public create(args: { username: string; bucket: string }): {
        s3EndpointUrl: pulumi.Output<string>;
        accessKey: pulumi.Output<string>;
        secretKey: pulumi.Output<string>;
    } {
        const password = createPassword(
            this,
            `${this.name}-${args.username}-password`,
        );

        const job = this.createJob(args.username, password, args.bucket);

        return {
            s3EndpointUrl: pulumi.output(this.args.s3EndpointUrl),
            accessKey: job.urn.apply(() => args.username),
            secretKey: pulumi.all([job.urn, password]).apply(([_, p]) => p),
        };
    }

    private createJob(
        username: string,
        password: pulumi.Output<string>,
        bucket: string,
    ): kubernetes.batch.v1.Job {
        const envSecret = this.createEnvSecret(username, password);
        const script = this.createScript(username, bucket);
        const scriptConfigMap = this.createScriptConfigMap(username, script);
        const policyJson = this.createPolicyJson(bucket);
        const policyConfigMap = this.createPolicyConfigMap(username, policyJson);

        const image = config.require(this.args.appName, 'provisioner/image');
        return new kubernetes.batch.v1.Job(
            `${this.name}-${username}`,
            {
                metadata: {
                    ...this.args.metadata.get({ component: username }),
                    name: `${this.name}-${username}`,
                },
                spec: {
                    backoffLimit: 0,
                    template: {
                        spec: {
                            containers: [
                                {
                                    name: 'rc',
                                    image,
                                    command: ['sh', '/config/script.sh'],
                                    envFrom: [
                                        { secretRef: { name: envSecret.metadata.name } },
                                    ],
                                    volumeMounts: [
                                        { name: 'config', mountPath: '/config' },
                                        { name: 'policy', mountPath: '/policy' },
                                    ],
                                },
                            ],
                            volumes: [
                                {
                                    name: 'config',
                                    configMap: { name: scriptConfigMap.metadata.name },
                                },
                                {
                                    name: 'policy',
                                    configMap: { name: policyConfigMap.metadata.name },
                                },
                            ],
                            restartPolicy: 'Never',
                        },
                    },
                },
            },
            { parent: this },
        );
    }

    private createEnvSecret(username: string, password: pulumi.Output<string>) {
        return new kubernetes.core.v1.Secret(
            `${this.name}-${username}-env`,
            {
                metadata: {
                    ...this.args.metadata.get({ component: username }),
                    name: `${this.name}-${username}-env`,
                },
                stringData: {
                    ROOT_PASSWORD: this.args.rootPassword,
                    USER_PASSWORD: password,
                },
            },
            { parent: this },
        );
    }

    private createPolicyJson(bucket: string): string {
        return JSON.stringify({
            Version: '2012-10-17',
            Statement: [
                {
                    Effect: 'Allow',
                    Action: ['s3:*'],
                    Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
                },
            ],
        });
    }

    private createScript(username: string, bucket: string): pulumi.Output<string> {
        const policyName = `${username}-policy`;
        const connectCmd = pulumi.interpolate`rc alias set ${this.name} "${this.args.s3EndpointUrl}" "${this.args.rootUser}" "$ROOT_PASSWORD" --insecure`;

        const commands = [
            `rc admin user add ${this.name} ${username} "$USER_PASSWORD"`,
            `rc mb ${this.name}/${bucket} --ignore-existing`,
            `rc admin policy info ${this.name} ${policyName} >/dev/null 2>&1 || rc admin policy create ${this.name} ${policyName} /policy/policy.json`,
            `rc admin policy attach ${this.name} ${policyName} --user ${username}`,
        ];

        return pulumi
            .all([connectCmd, ...commands])
            .apply(([connect, ...cmds]) =>
                [
                    '#!/bin/sh',
                    'set -e',
                    '',
                    `echo 'Waiting for RustFS to be ready...'`,
                    `until ${connect}; do`,
                    `  echo 'RustFS not ready, retrying in 10 seconds...'`,
                    `  sleep 10`,
                    `done`,
                    ...cmds.flatMap(cmd => ['', `echo '${cmd}'`, cmd]),
                ].join('\n'),
            );
    }

    private createScriptConfigMap(
        username: string,
        script: pulumi.Output<string>,
    ): kubernetes.core.v1.ConfigMap {
        return new kubernetes.core.v1.ConfigMap(
            `${this.name}-${username}-script`,
            {
                metadata: {
                    ...this.args.metadata.get({ component: username }),
                    name: `${this.name}-${username}-script`,
                },
                data: { 'script.sh': script },
            },
            { parent: this },
        );
    }

    private createPolicyConfigMap(
        username: string,
        policyJson: string,
    ): kubernetes.core.v1.ConfigMap {
        return new kubernetes.core.v1.ConfigMap(
            `${this.name}-${username}-policy`,
            {
                metadata: {
                    ...this.args.metadata.get({ component: username }),
                    name: `${this.name}-${username}-policy`,
                },
                data: { 'policy.json': policyJson },
            },
            { parent: this },
        );
    }
}
