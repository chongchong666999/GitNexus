/**
 * Cocos UUID codec helpers.
 *
 * Cocos Creator 2.x often stores script component types as compressed UUID tokens
 * (commonly 23 chars: 5 hex + 18 base64 chars, e.g. c2d74/E6FNERaFpk6D5H6WT).
 * This module normalizes those tokens into canonical UUID form.
 */

const HEX = '0123456789abcdef';
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const BASE64_TO_INT = new Int16Array(128).fill(-1);
for (let i = 0; i < BASE64.length; i++) {
  BASE64_TO_INT[BASE64.charCodeAt(i)] = i;
}

const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32_RE = /^[0-9a-f]{32}$/i;
const COCOS_UUID_23_RE = /^[0-9a-f]{5}[A-Za-z0-9+/]{18}$/;
const COCOS_UUID_22_RE = /^[0-9a-f]{2}[A-Za-z0-9+/]{20}$/;

function toCanonicalUuidFromHex(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Decode Cocos compressed UUID token into canonical UUID.
 * Supports common 23-char and 22-char compact forms.
 */
export function decodeCompressedCocosUuid(token: string): string | null {
  const raw = token.trim();
  if (!raw) return null;

  const lower = raw.toLowerCase();
  let headHex = '';
  let encoded = '';

  if (COCOS_UUID_23_RE.test(lower)) {
    headHex = lower.slice(0, 5);
    encoded = raw.slice(5);
  } else if (COCOS_UUID_22_RE.test(lower)) {
    headHex = lower.slice(0, 2);
    encoded = raw.slice(2);
  } else {
    return null;
  }

  let hex = headHex;
  for (let i = 0; i < encoded.length; i += 2) {
    const lhs = BASE64_TO_INT[encoded.charCodeAt(i)] ?? -1;
    const rhs = BASE64_TO_INT[encoded.charCodeAt(i + 1)] ?? -1;
    if (lhs < 0 || rhs < 0) return null;

    hex += HEX[lhs >> 2];
    hex += HEX[((lhs & 0x3) << 2) | (rhs >> 4)];
    hex += HEX[rhs & 0x0f];
  }

  if (!HEX32_RE.test(hex)) return null;
  return toCanonicalUuidFromHex(hex.toLowerCase());
}

/** Normalize uuid-like input into canonical UUID form when possible. */
export function normalizeUuidLike(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;

  if (CANONICAL_UUID_RE.test(raw)) {
    return raw.toLowerCase();
  }

  if (HEX32_RE.test(raw)) {
    return toCanonicalUuidFromHex(raw.toLowerCase());
  }

  return decodeCompressedCocosUuid(raw);
}

/**
 * Resolve a uuid-like token to a source path using meta UUID map.
 * Accepts canonical UUIDs and Cocos compressed UUID tokens.
 */
export function resolveMetaPathByUuidLike(
  metaUuidMap: Map<string, string>,
  uuidLike: string,
): string | undefined {
  const direct = metaUuidMap.get(uuidLike);
  if (direct) return direct;

  const lowerDirect = metaUuidMap.get(uuidLike.toLowerCase());
  if (lowerDirect) return lowerDirect;

  const normalized = normalizeUuidLike(uuidLike);
  if (!normalized) return undefined;

  return metaUuidMap.get(normalized) || metaUuidMap.get(normalized.toLowerCase());
}
