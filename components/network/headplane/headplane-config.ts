/**
 * Renders Headplane's `config.yaml`.
 *
 * Pure: every value arrives resolved, so the document can be read (and diffed)
 * without tracing Outputs or Pulumi config. The component resolves them.
 */

const HEADSCALE_SECTION = `headscale:
  # In-cluster Service. Headplane's server calls Headscale directly over gRPC, so
  # this never crosses the public hostname and needs no route of its own.
  url: "http://headscale.headscale.svc.cluster.local:8080"
  api_key_path: /etc/headplane/api_key`;

const INTEGRATION_SECTION = `# Network management and Web SSH both need read/write access to Headscale's
# config file and the Docker socket. Neither applies to a Kubernetes deployment,
# so they stay off rather than being wired up to something unreachable.
integration:
  agent:
    enabled: false
  docker:
    enabled: false
  kubernetes:
    enabled: false
    # Required by Headplane's own validation even with the integration off.
    pod_name: "headscale"
  proc:
    enabled: false`;

export function createHeadplaneConfig({
    baseUrl,
    oidc,
}: {
    baseUrl: string;
    oidc?: { issuer: string; clientId: string };
}): string {
    const sections = [
        createServerSection(baseUrl),
        HEADSCALE_SECTION,
        INTEGRATION_SECTION,
        oidc ? createOidcSection(oidc) : undefined,
    ].filter((section): section is string => section !== undefined);

    return `${sections.join('\n\n')}\n`;
}

function createServerSection(baseUrl: string): string {
    return `server:
  host: "0.0.0.0"
  port: 3000
  base_url: "${baseUrl}"
  cookie_secret_path: /etc/headplane/cookie_secret
  cookie_secure: true
  cookie_max_age: 86400
  data_path: "/var/lib/headplane"`;
}

function createOidcSection(oidc: { issuer: string; clientId: string }): string {
    return `oidc:
  issuer: ${oidc.issuer}
  client_id: ${oidc.clientId}
  client_secret_path: /etc/headplane/client_secret
  scope: "openid profile email groups"
  # Roles come from a Pocket ID group custom claim, not from group names.
  # Pocket ID releases custom claims under the profile scope and does not
  # resolve conflicts between groups setting the same claim, so every group
  # that grants access needs its own value here.
  role_claim: headplane_role
  # Anyone in an allowed group without a role claim (e.g. vpn-users) gets
  # Headplane's default member role rather than admin/viewer visibility.
  default_role: member
  # The OIDC client is shared with Headscale, which requires PKCE. Pocket ID
  # enforces that requirement, so without this the token exchange is rejected
  # with "the 'code_challenge' parameter is missing".
  use_pkce: true`;
}
