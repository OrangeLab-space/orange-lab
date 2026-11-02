import { Nip05Document } from './nip05';

/**
 * Renders Caddy's `Caddyfile`.
 *
 * Pure: every value arrives resolved, so the document can be read (and diffed)
 * without tracing Outputs or Pulumi config. The component resolves them.
 */
export function createCaddyfile({
    issuer,
    subject,
    redirect,
    nip05,
}: {
    issuer: string;
    subject: string;
    redirect?: string;
    nip05?: Nip05Document;
}): string {
    const webfinger = JSON.stringify({
        subject,
        links: [
            {
                rel: 'http://openid.net/specs/connect/1.0/issuer',
                href: issuer,
            },
        ],
    });

    // The catch-all redirect is optional - without it the apex only answers
    // WebFinger, NIP-05 and robots.txt, and everything else gets Caddy's own
    // 404. `handle` blocks are exclusive and evaluated in order, which is what
    // gives the .well-known documents and robots.txt precedence.
    const redirectHandler = redirect
        ? `\thandle {\n\t\tredir ${redirect} 302\n\t}\n`
        : '';

    // NIP-05 clients fetch this cross-origin from web clients, so the document
    // needs CORS. It is static and complete, so `?name=` needs no handling.
    const nip05Handler = nip05
        ? `\n\thandle /.well-known/nostr.json {\n\t\theader Content-Type application/json\n\t\theader Access-Control-Allow-Origin *\n\t\trespond \`${JSON.stringify(nip05)}\` 200\n\t}\n`
        : '';

    // Backtick strings keep the JSON and the robots.txt body literal, so neither
    // needs Caddyfile escaping.
    return `{
	admin off
	auto_https off
}

:8080 {
	log {
		output stdout
	}

	handle /.well-known/webfinger {
		header Content-Type application/jrd+json
		respond \`${webfinger}\` 200
	}
${nip05Handler}
	handle /robots.txt {
		header Content-Type text/plain
		respond \`User-agent: *
Disallow: /
\` 200
	}
${redirectHandler}
}
`;
}
