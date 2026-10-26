/**
 * Renders Headscale's `config.yaml`.
 *
 * Pure: every value arrives resolved, so the document can be read (and diffed)
 * without tracing Outputs or Pulumi config. The component resolves them.
 */

interface DerpSettings {
    enabled: boolean;
    stunPort: number;
    regionId: number;
    regionCode: string;
    fallback: boolean;
    externalIp?: string;
}

interface DnsSettings {
    overrideLocalDns: boolean;
    nameservers?: string[];
}

interface OidcSettings {
    issuer: string;
    clientId: string;
}

const NOISE_SECTION = `noise:
  private_key_path: /var/lib/headscale/noise_private.key`;

const PREFIXES_SECTION = (tailnetCidr: string) => `prefixes:
  v4: ${tailnetCidr}
  v6: fd7a:115c:a1e0::/48
  allocation: sequential`;

const DATABASE_SECTION = `database:
  type: sqlite
  sqlite:
    path: /var/lib/headscale/db.sqlite
    write_ahead_log: true`;

export function createHeadscaleConfig({
    serverUrl,
    trustedProxyCidr,
    tailnetCidr,
    baseDomain,
    logLevel,
    derp,
    dns,
    oidc,
}: {
    serverUrl: string;
    trustedProxyCidr: string;
    tailnetCidr: string;
    baseDomain: string;
    logLevel: string;
    derp: DerpSettings;
    dns: DnsSettings;
    oidc?: OidcSettings;
}): string {
    const sections = [
        createServerSection(serverUrl),
        createTrustedProxiesSection(trustedProxyCidr),
        NOISE_SECTION,
        PREFIXES_SECTION(tailnetCidr),
        createDerpSection(derp),
        DATABASE_SECTION,
        createLogSection(logLevel),
        createDnsSection(dns, baseDomain),
        oidc ? createOidcSection(oidc) : undefined,
    ].filter((section): section is string => section !== undefined);

    return `${sections.join('\n\n')}\n`;
}

function createServerSection(serverUrl: string): string {
    return `server_url: ${serverUrl}
listen_addr: 0.0.0.0:8080`;
}

function createTrustedProxiesSection(trustedProxyCidr: string): string {
    return `# Only peers in the cluster network may supply client address headers.
# Traefik's pods live there; without this every client is logged as the proxy's
# address. Real addresses come from X-Real-IP or X-Forwarded-For, which Traefik
# sanitizes. True-Client-IP is stripped on the route because Traefik does not.
trusted_proxies:
  - ${trustedProxyCidr}`;
}

const DERP_COMMENT = `# The embedded relay is served at /derp on this same listener, so clients reach
# it through the routing provider like everything else — it needs no port of its
# own. Only STUN is separate, and it is absent unless derp/enabled is set.`;

function createDerpSection(derp: DerpSettings): string {
    if (!derp.enabled) {
        return `${DERP_COMMENT}
derp:
  server:
    enabled: false
  urls:
    - https://controlplane.tailscale.com/derpmap/default
  auto_update_enabled: true`;
    }

    // Headscale fetches `urls` while starting and treats a failure as fatal,
    // so this setting decides whether reaching Tailscale is a prerequisite for
    // the control plane coming up at all.
    const urls = derp.fallback
        ? `  urls:
    - https://controlplane.tailscale.com/derpmap/default`
        : '  urls: []';
    const externalIpLine =
        derp.externalIp === undefined ? '' : `    ipv4: ${derp.externalIp}\n`;

    return `${DERP_COMMENT}
derp:
  server:
    enabled: true
    region_id: ${String(derp.regionId)}
    region_code: ${derp.regionCode}
    region_name: ${derp.regionCode}
    stun_listen_addr: 0.0.0.0:${String(derp.stunPort)}
${externalIpLine}    # On the volume, so a restart does not present a new key and make every
    # client treat the relay as a different one.
    private_key_path: /var/lib/headscale/derp_server_private.key
    automatically_add_embedded_derp_region: true
    # Refuse relay access to node keys this control plane does not know.
    # Headscale defaults to true; set it so an image bump cannot silently
    # open the relay.
    verify_clients: true
${urls}`;
}

function createLogSection(logLevel: string): string {
    return `log:
  level: ${logLevel}`;
}

function createDnsSection(dns: DnsSettings, baseDomain: string): string {
    // Headscale keeps the node's own resolver unless overrideLocalDns is set,
    // in which case it forces the nameservers below onto every client. There is
    // no separate fallback list: the nameservers either become the primary
    // resolvers (override on) or the fallback resolvers (off), and the latter is
    // only consulted by a node using an exit node.
    const nameservers = dns.nameservers?.length
        ? `\n\n  nameservers:\n    global:\n${dns.nameservers
              .map(ns => `      - ${ns}`)
              .join('\n')}`
        : '';

    return `dns:
  magic_dns: true
  base_domain: ${baseDomain}
  override_local_dns: ${String(dns.overrideLocalDns)}${nameservers}`;
}

// Headscale embeds the OIDC client secret through a file path, so it is
// projected next to this document rather than interpolated into it.
function createOidcSection(oidc: OidcSettings): string {
    return `oidc:
  # Fail at startup rather than serving a login button that cannot work.
  only_start_if_oidc_is_available: true
  issuer: ${oidc.issuer}
  client_id: ${oidc.clientId}
  client_secret_path: /etc/headscale/client_secret
  scope: ["openid", "profile", "email"]
  pkce:
    enabled: true
    method: S256`;
}
