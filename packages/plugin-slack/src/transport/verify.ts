import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify Slack request signature using HMAC-SHA256.
 * Ported verbatim from legacy `src/channels/verify.ts` (origin/main).
 * Uses Web Crypto API; async — used by TriggerDef.verify (which may be async).
 */
export async function verifySlackSignature(
  rawHeaders: Record<string, string>,
  rawBody: string,
  signingSecret: string,
): Promise<boolean> {
  const timestamp = rawHeaders["x-slack-request-timestamp"];
  const signature = rawHeaders["x-slack-signature"];

  if (!timestamp || !signature) return false;

  // Reject requests older than 5 minutes (replay protection). The finite check
  // is what enforces it: `Number("junk")` is NaN, and every comparison against
  // NaN is false, so a non-numeric timestamp would slip past a bare `> 300`
  // with no window applied at all.
  const sent = Number(timestamp);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(sent) || Math.abs(now - sent) > 300) return false;

  // Compute HMAC-SHA256
  const baseString = `v0:${timestamp}:${rawBody}`;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(baseString));

  // Convert to hex
  const digest = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const expected = `v0=${digest}`;

  // Timing-safe comparison. Guard on BYTE length, not string length — the
  // loop below indexes the encoded arrays, and a signature header with a
  // multibyte character can match `expected.length` while encoding to more
  // bytes, which would compare a prefix instead of the whole value. Same
  // reasoning as `verifySlackSignatureSync`.
  const expectedBytes = encoder.encode(expected);
  const signatureBytes = encoder.encode(signature);
  if (expectedBytes.length !== signatureBytes.length) return false;

  // Use constant-time comparison
  let mismatch = 0;
  for (let i = 0; i < expectedBytes.length; i++) {
    mismatch |= expectedBytes[i] ^ signatureBytes[i];
  }

  return mismatch === 0;
}

/**
 * Synchronous variant for ChannelTransport.verifyWebhook, whose engine
 * contract is sync (`RawChannelUpdate[] | null`, no Promise). Same semantics
 * as verifySlackSignature: v0:{ts}:{body} HMAC-SHA256, constant-time compare,
 * 300s replay window — implemented over node:crypto instead of Web Crypto.
 */
export function verifySlackSignatureSync(
  rawHeaders: Record<string, string>,
  rawBody: string,
  signingSecret: string,
): boolean {
  const timestamp = rawHeaders["x-slack-request-timestamp"];
  const signature = rawHeaders["x-slack-signature"];

  if (!timestamp || !signature) return false;

  // Same finite check as the async version: a NaN timestamp compares false
  // against every bound, which would leave the replay window unenforced.
  const sent = Number(timestamp);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(sent) || Math.abs(now - sent) > 300) return false;

  const digest = createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  const expected = `v0=${digest}`;

  // Guard on BYTE length, not string length: a crafted signature header with a
  // multibyte char can match `expected.length` yet differ in encoded bytes,
  // and timingSafeEqual throws RangeError on unequal-length buffers — which,
  // uncaught in the webhook route, would surface as an unauthenticated 500
  // instead of a clean rejection.
  const encoder = new TextEncoder();
  const expectedBytes = encoder.encode(expected);
  const signatureBytes = encoder.encode(signature);
  if (expectedBytes.length !== signatureBytes.length) return false;
  return timingSafeEqual(expectedBytes, signatureBytes);
}
