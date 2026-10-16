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

function stripNul(value: string): string {
  return value.replaceAll("\u0000", "");
}

/**
 * `digest` with NUL removed from every string and `text` cut to
 * `EVENT_DIGEST_TEXT_MAX_BYTES`. Postgres rejects NUL in text and jsonb, so
 * both stores call this in `appendEventMatch` and accept the same digests.
 */
export function boundEventDigest(digest: EventMatchDigest): EventMatchDigest {
  const out: EventMatchDigest = {
    key: stripNul(digest.key),
    subjects: digest.subjects.map(stripNul),
    summary: stripNul(digest.summary),
    occurredAt: stripNul(digest.occurredAt),
    dedupeKey: stripNul(digest.dedupeKey),
  };
  const optional = ["status", "previousStatus", "url", "actor", "derive"] as const;
  for (const field of optional) {
    const value = digest[field];
    if (value !== undefined) out[field] = stripNul(value);
  }
  if (digest.text !== undefined) out.text = cutUtf8(stripNul(digest.text), EVENT_DIGEST_TEXT_MAX_BYTES);
  return out;
}
