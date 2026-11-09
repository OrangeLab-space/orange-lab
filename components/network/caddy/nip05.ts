import { toHexPubkey } from '@orangelab/pulumi';

/** A NIP-05 document as served at `/.well-known/nostr.json`. */
export interface Nip05Document {
    names: Record<string, string>;
    relays?: Record<string, string[]>;
}

const LOCAL_NAME = /^[a-z0-9._-]+$/;

/**
 * Validates the `caddy:nip05/*` keys and turns them into the document clients
 * expect. `npub1…` values are decoded to hex so the config stays readable
 * while the file carries the hex keys NIP-05 requires.
 */
export function parseNip05(
    pubkeys: unknown,
    relays: unknown,
    defaultRelays: unknown,
): Nip05Document | undefined {
    if (pubkeys === undefined) return undefined;

    const defaults = parseRelayUrls(defaultRelays, 'caddy:nip05/defaultRelays');
    const overrides = parseRelayMap(relays);
    const names: Record<string, string> = {};
    const hints: Record<string, string[]> = {};

    for (const [name, value] of Object.entries(
        requireRecord(pubkeys, 'caddy:nip05/pubkeys'),
    )) {
        if (!LOCAL_NAME.test(name)) {
            throw new Error(
                `caddy:nip05/pubkeys.${name}: the name may only contain lowercase letters, digits, '.', '_' and '-'.`,
            );
        }
        const pubkey = toHexPubkey(value, `caddy:nip05/pubkeys.${name}`);
        names[name] = pubkey;
        const list = overrides[name] ?? defaults;
        if (list.length > 0) hints[pubkey] = list;
    }

    if (Object.keys(names).length === 0) {
        throw new Error('caddy:nip05/pubkeys must contain at least one name.');
    }
    for (const name of Object.keys(overrides)) {
        if (!Object.hasOwn(names, name)) {
            throw new Error(
                `caddy:nip05/relays.${name}: no matching entry in caddy:nip05/pubkeys.`,
            );
        }
    }

    return Object.keys(hints).length > 0 ? { names, relays: hints } : { names };
}

function parseRelayMap(raw: unknown): Record<string, string[]> {
    if (raw === undefined) return {};

    const map: Record<string, string[]> = {};
    for (const [name, value] of Object.entries(
        requireRecord(raw, 'caddy:nip05/relays'),
    )) {
        map[name] = parseRelayUrls(value, `caddy:nip05/relays.${name}`);
    }
    return map;
}

function parseRelayUrls(raw: unknown, key: string): string[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
        throw new Error(`${key} must be a YAML list of ws:// or wss:// relay URLs.`);
    }
    return raw.map((value, index) => parseRelayUrl(value, `${key}[${String(index)}]`));
}

function parseRelayUrl(raw: unknown, key: string): string {
    if (typeof raw !== 'string') {
        throw new Error(`${key} must be a ws:// or wss:// relay URL.`);
    }
    if (raw.includes('`')) {
        throw new Error(
            `${key}: relay URLs cannot contain a backtick (Caddyfile string delimiter).`,
        );
    }

    let protocol: string;
    try {
        protocol = new URL(raw).protocol;
    } catch {
        throw new Error(`${key}: "${raw}" is not a valid URL.`);
    }
    if (protocol !== 'ws:' && protocol !== 'wss:') {
        throw new Error(`${key}: "${raw}" must use ws:// or wss://.`);
    }
    return raw;
}

function requireRecord(raw: unknown, key: string): Record<string, unknown> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`${key} must be a YAML object keyed by name.`);
    }
    return raw as Record<string, unknown>;
}
