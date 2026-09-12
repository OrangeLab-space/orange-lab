import { config } from './config';
import { SmtpSecurity, SmtpSettings } from './types';

export class Smtp {
    constructor(private readonly appName: string) {}

    getSettings(): SmtpSettings {
        const secure = config.requireEnum(this.appName, 'smtp/secure', SmtpSecurity);
        if (!config.requireBoolean(this.appName, 'smtp/enabled')) {
            return { enabled: false };
        }

        return {
            enabled: true,
            from: config.require(this.appName, 'smtp/from'),
            host: config.require(this.appName, 'smtp/host'),
            port: config.requireNumber(this.appName, 'smtp/port'),
            secure,
            username: config.require(this.appName, 'smtp/username'),
            password: config.requireSecret(this.appName, 'smtp/password'),
        };
    }
}
