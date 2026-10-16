// Event waiter digest bounds (spec 2026-10-15: event wakeups, INV-E7).
// Pure functions with no node imports, so the engine barrel stays
// browser-safe.

import { EVENT_DIGEST_TEXT_MAX_BYTES, type EventMatchDigest } from "./types.js";

function codePointBytes(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * The longest prefix of `text` whose UTF-8 encoding is at most `maxBytes`
 * bytes. It cuts only between code points, so it never splits a character.
 */
export function cutUtf8(text: string, maxBytes: number): string {
  // A string of n UTF-16 units encodes to at most 3n bytes.
  if (text.length * 3 <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const next = bytes + codePointBytes(ch.codePointAt(0) ?? 0);
    if (next > maxBytes) break;
    bytes = next;
    end += ch.length;
  }
  return text.slice(0, end);
}

/** `digest` with `text` cut to `EVENT_DIGEST_TEXT_MAX_BYTES`. Stores call it in `appendEventMatch`. */
export function boundEventDigest(digest: EventMatchDigest): EventMatchDigest {
  if (digest.text === undefined) return digest;
  const text = cutUtf8(digest.text, EVENT_DIGEST_TEXT_MAX_BYTES);
  return text === digest.text ? digest : { ...digest, text };
}
