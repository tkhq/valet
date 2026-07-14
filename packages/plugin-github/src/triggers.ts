import type { TriggerDef, VerifiedEvent } from "@valet/engine";

const GITHUB_EVENT_TYPES = [
  "push",
  "pull_request",
  "issues",
  "issue_comment",
  "create",
  "delete",
  "release",
  "workflow_run",
  "check_run",
  "check_suite",
  "status",
  "ping",
];

/**
 * Ported verbatim from the legacy `githubTriggers.verifySignature` (formerly
 * `src/actions/triggers.ts`), adapted from `(headers, rawBody: string, secret)`
 * to `(headers, rawBody: Uint8Array, secret)` — the HMAC is computed over the
 * raw bytes rather than a decoded string so no encoding round-trip can change
 * what's verified.
 */
async function verifySignature(
  rawHeaders: Record<string, string>,
  rawBody: Uint8Array,
  secret: string,
): Promise<boolean> {
  const signature = lookupHeader(rawHeaders, "x-hub-signature-256");
  if (!signature) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  // `new Uint8Array(rawBody)` normalizes the ArrayBufferLike backing store to
  // a plain ArrayBuffer — TS's DOM lib types crypto.subtle.sign as requiring
  // BufferSource<ArrayBuffer>, which a Uint8Array<ArrayBufferLike> parameter
  // doesn't structurally satisfy.
  const sig = await crypto.subtle.sign("HMAC", key, new Uint8Array(rawBody));
  const expected =
    "sha256=" +
    Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  // Timing-safe comparison (constant-time for equal-length strings)
  if (signature.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < signature.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Ported verbatim from the legacy `githubTriggers.parseWebhook`, adapted to
 * take the already-decoded body string (the caller decodes `rawBody` once
 * via `TextDecoder`, after HMAC verification has run over the raw bytes).
 */
function parseWebhook(
  rawHeaders: Record<string, string>,
  rawBody: string,
): { eventType: string; action: string | undefined; payload: unknown; deliveryId: string | undefined } {
  const eventType = lookupHeader(rawHeaders, "x-github-event") || "unknown";
  const deliveryId = lookupHeader(rawHeaders, "x-github-delivery");

  const payload = JSON.parse(rawBody) as Record<string, unknown>;
  const action = typeof payload.action === "string" ? payload.action : undefined;

  return {
    eventType,
    action,
    payload,
    deliveryId,
  };
}

function lookupHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function makeVerify(eventFamily: string): TriggerDef["verify"] {
  return async (req, secrets) => {
    const secret = secrets.webhookSecret;
    if (!secret) return null;

    const ok = await verifySignature(req.headers, req.rawBody, secret);
    if (!ok) return null;

    const rawBodyText = new TextDecoder().decode(req.rawBody);
    const { eventType, payload, deliveryId } = parseWebhook(req.headers, rawBodyText);
    if (eventType !== eventFamily) return null;
    if (!deliveryId) return null;

    return {
      eventType,
      deliveryId,
      payload,
    };
  };
}

const toSignal: TriggerDef["toSignal"] = (event: VerifiedEvent) => {
  const payload = event.payload as Record<string, unknown>;
  const action = typeof payload.action === "string" ? payload.action : undefined;
  return {
    signal: {
      kind: "signal",
      signalType: `github.${event.eventType}`,
      body: JSON.stringify(event.payload),
      attributes: {
        deliveryId: event.deliveryId,
        ...(action ? { action } : {}),
      },
    },
    dispatchId: event.deliveryId,
  };
};

export const githubTriggerDefs: TriggerDef[] = GITHUB_EVENT_TYPES.map((eventType) => ({
  id: `github.${eventType}`,
  service: "github",
  description: `GitHub webhook event: ${eventType}`,
  verify: makeVerify(eventType),
  toSignal,
}));
