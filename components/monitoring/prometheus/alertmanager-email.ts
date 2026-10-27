import { SmtpSettingsEnabled, config } from '@orangelab/pulumi';
import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

export interface AlertmanagerEmailArgs {
    name: string;
    namespace: pulumi.Input<string>;
    parent: pulumi.ComponentResource;
    smtp: SmtpSettingsEnabled;
}

/**
 * Routes every alert except the Watchdog to an email receiver. The operator
 * picks the AlertmanagerConfig up from the empty config selectors and reloads
 * Alertmanager, so no chart values are involved.
 */
export function createAlertmanagerEmail({
    name,
    namespace,
    parent,
    smtp,
}: AlertmanagerEmailArgs) {
    const secretName = `${name}-alertmanager-smtp`;
    const passwordSecret = new kubernetes.core.v1.Secret(
        `${secretName}-secret`,
        {
            metadata: { name: secretName, namespace },
            // `data` rather than `stringData`: stringData is write-only, so the
            // provider cannot verify it and a change would need a replacement.
            data: {
                password: smtp.password.apply(password =>
                    Buffer.from(password).toString('base64'),
                ),
            },
        },
        { parent },
    );

    new kubernetes.apiextensions.CustomResource(
        `${name}-alertmanager-email`,
        {
            apiVersion: 'monitoring.coreos.com/v1alpha1',
            kind: 'AlertmanagerConfig',
            metadata: { name: 'email', namespace },
            spec: {
                route: {
                    groupBy: ['alertname', 'namespace'],
                    groupInterval: '5m',
                    groupWait: '30s',
                    matchers: [{ matchType: '!=', name: 'alertname', value: 'Watchdog' }],
                    receiver: 'email',
                    repeatInterval: '4h',
                },
                receivers: [
                    {
                        emailConfigs: [
                            {
                                authPassword: { key: 'password', name: secretName },
                                authUsername: smtp.username,
                                from: smtp.from,
                                // Port 465 makes Alertmanager use implicit TLS on
                                // its own; require_tls only governs STARTTLS.
                                requireTLS: smtp.secure === 'starttls',
                                sendResolved: true,
                                smarthost: `${smtp.host}:${String(smtp.port)}`,
                                to: config.require(name, 'alertmanager/emailTo'),
                            },
                        ],
                        name: 'email',
                    },
                ],
            },
        },
        { dependsOn: passwordSecret, parent },
    );
}
