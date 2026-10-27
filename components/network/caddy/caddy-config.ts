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
}: {
    issuer: string;
    subject: string;
    redirect?: string;
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
    // WebFinger and robots.txt, and everything else gets Caddy's own 404.
    // `handle` blocks are exclusive and evaluated in order, which is what gives
    // webfinger and robots.txt precedence.
    const redirectHandler = redirect
        ? `\thandle {\n\t\tredir ${redirect} 302\n\t}\n`
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
