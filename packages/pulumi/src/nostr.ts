import { bech32, hex } from '@scure/base';

const HEX_PUBKEY = /^[0-9a-f]{64}$/;
const PUBKEY_LENGTH = 32;

/**
 * Accepts an `npub1…` or 64-character hex public key and returns lowercase hex,
 * the form Nostr config files and relay env vars require. `key` names the
 * setting in error messages.
 */
export function toHexPubkey(value: unknown, key: string): string {
    if (typeof value !== 'string') {
        throw new Error(`${key} must be an npub1… or 64-character hex public key.`);
    }

    const normalised = value.trim().toLowerCase();
    if (HEX_PUBKEY.test(normalised)) return normalised;
    if (!normalised.startsWith('npub1')) {
        throw new Error(
            `${key}: "${value}" must be an npub1… or 64-character hex public key.`,
        );
    }

    let decoded: { prefix: string; words: number[] };
    try {
        decoded = bech32.decode(normalised as `${string}1${string}`);
    } catch (error) {
        throw new Error(
            `${key}: "${value}" is not a valid npub1 key (${(error as Error).message})`,
            { cause: error },
        );
    }
    if (decoded.prefix !== 'npub') {
        throw new Error(`${key}: expected an npub1… key, got ${decoded.prefix}1….`);
    }

    const bytes = bech32.fromWords(decoded.words);
    if (bytes.length !== PUBKEY_LENGTH) {
        throw new Error(
            `${key}: npub decodes to ${String(bytes.length)} bytes, expected ${String(PUBKEY_LENGTH)}.`,
        );
    }
    return hex.encode(bytes);
}
