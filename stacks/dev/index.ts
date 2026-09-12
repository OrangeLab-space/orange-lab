import { config } from '@orangelab/pulumi';
import { Debug } from './components/debug/debug';
import { Forgejo } from './components/forgejo/forgejo';

if (config.isEnabled('debug')) {
    new Debug('debug');
}

const forgejo = config.isEnabled('forgejo') ? new Forgejo('forgejo') : undefined;

export const endpoints = {
    forgejo: forgejo?.serviceUrl,
    forgejoSsh: forgejo?.sshUrl,
};
