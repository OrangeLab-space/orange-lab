import { Application, config } from '@orangelab/pulumi';
import * as pulumi from '@pulumi/pulumi';

export class Mosquitto extends pulumi.ComponentResource {
    public readonly app: Application;
    public readonly host: pulumi.Input<string>;
    public readonly port = 1883;
    public readonly username: string;
    public readonly password: pulumi.Output<string>;

    constructor(name: string, opts?: pulumi.ResourceOptions) {
        super('orangelab:iot:Mosquitto', name, {}, opts);

        this.username = config.require(name, 'user');
        this.password = config.requireSecret(name, 'password');

        this.app = new Application(this, name).addStorage();
        this.host = this.app.metadata.namespace.apply(
            namespace => `${name}.${namespace}`,
        );
        if (this.app.storageOnly) return;

        this.app.addConfigVolume({
            name: 'config',
            files: { 'mosquitto.conf': this.createConfigFile() },
            secretFiles: {
                user: this.username,
                password: this.password,
            },
        });
        this.app.addDeployment({
            image: config.require(name, 'image'),
            initContainers: [
                {
                    name: 'init-password',
                    image: config.require(name, 'image'),
                    command: ['sh', '-c', this.createPasswordCommand()],
                    volumeMounts: [
                        {
                            mountPath: '/mosquitto/config',
                            name: 'config',
                            readOnly: true,
                        },
                        { mountPath: '/mosquitto/data' },
                    ],
                },
            ],
            ports: [{ name: 'mqtt', port: this.port, protocol: 'tcp', private: true }],
            resources: {
                requests: { cpu: '10m', memory: '32Mi' },
                limits: { cpu: '500m', memory: '128Mi' },
            },
            runAsUser: 1883,
            volumeOwnerUserId: 1883,
            volumeMounts: [
                { mountPath: '/mosquitto/config', name: 'config', readOnly: true },
                { mountPath: '/mosquitto/data' },
            ],
        });

        const brokerUrl = this.app.network.clusterEndpoints[`${name}-mqtt`];
        if (brokerUrl) this.app.network.addClusterEndpoint(name, brokerUrl);
    }

    private createConfigFile() {
        return [
            'persistence true',
            'persistence_location /mosquitto/data/',
            'log_dest stdout',
            'listener 1883',
            'allow_anonymous false',
            'password_file /mosquitto/data/passwd',
            '',
        ].join('\n');
    }

    private createPasswordCommand() {
        return [
            'rm -f /mosquitto/data/passwd',
            '&& mosquitto_passwd -b -c /mosquitto/data/passwd',
            '"$(cat /mosquitto/config/user)"',
            '"$(cat /mosquitto/config/password)"',
            '&& chown mosquitto:mosquitto /mosquitto/data/passwd',
            '&& chmod 600 /mosquitto/data/passwd',
        ].join(' ');
    }
}
