import type { EventCatalogEntry, NormalizedEvent, TriggerDef, VerifiedEvent } from "@valet/engine";

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

/** Actions GitHub documents per event family — drives the catalog. Families
 * not listed here (push, create, delete, status, ping) have no `action`. */
const EVENT_ACTIONS: Record<string, string[]> = {
  pull_request: ["opened", "closed", "reopened", "synchronize", "edited", "ready_for_review", "labeled", "unlabeled"],
  issues: ["opened", "closed", "reopened", "edited", "labeled", "unlabeled", "assigned", "unassigned"],
  issue_comment: ["created", "edited", "deleted"],
  release: ["published", "created", "edited", "deleted"],
  workflow_run: ["completed", "requested", "in_progress"],
  check_run: ["completed", "created", "rerequested"],
  check_suite: ["completed", "requested", "rerequested"],
};

const COMMON_FILTERS: EventCatalogEntry["filters"] = [
  { field: "repo", path: "repository.full_name", description: "Repository (owner/name)" },
  { field: "sender", path: "sender.login", description: "GitHub login of the actor" },
];

function catalogFor(eventType: string): EventCatalogEntry[] {
  // ping is the webhook-setup handshake, not a subscribable event; its payload
  // has no `repository` so the repo filter would be non-functional anyway.
  if (eventType === "ping") return [];

  const actions = EVENT_ACTIONS[eventType];
  if (!actions) {
    return [{ key: `github.${eventType}`, description: `GitHub ${eventType} event`, filters: COMMON_FILTERS }];
  }
  return actions.map((action) => ({
    key: `github.${eventType}.${action}`,
    description: `GitHub ${eventType} ${action}`,
    filters: COMMON_FILTERS,
  }));
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
}

function toEvent(event: VerifiedEvent): NormalizedEvent {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const action = typeof payload.action === "string" ? payload.action : undefined;
  const repository = payload.repository as Record<string, unknown> | undefined;
  const installation = payload.installation as Record<string, unknown> | undefined;
  const sender = payload.sender as Record<string, unknown> | undefined;

  const refs: Record<string, string> = {};
  const repo = str(repository?.full_name);
  if (repo) refs.repo = repo;
  const installationId = str(installation?.id);
  if (installationId) refs.installation_id = installationId;

  const senderId = str(sender?.id);
  const senderLogin = str(sender?.login);

  const summaryParts = [repo, `${event.eventType}${action ? ` ${action}` : ""}`, senderLogin ? `by ${senderLogin}` : undefined];
  return {
    key: action ? `github.${event.eventType}.${action}` : `github.${event.eventType}`,
    dedupeKey: event.deliveryId,
    occurredAt: new Date().toISOString(),
    actor: senderId ? { externalId: senderId, login: senderLogin } : undefined,
    refs,
    summary: summaryParts.filter(Boolean).join(" — "),
    payload: event.payload,
  };
}

export const githubTriggerDefs: TriggerDef[] = GITHUB_EVENT_TYPES.map((eventType) => ({
  id: `github.${eventType}`,
  service: "github",
  description: `GitHub webhook event: ${eventType}`,
  verify: makeVerify(eventType),
  toEvent,
  catalog: catalogFor(eventType),
}));
