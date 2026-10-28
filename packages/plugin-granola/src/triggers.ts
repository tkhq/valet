import { createHmac, timingSafeEqual } from "node:crypto";
import type { NormalizedEvent, TriggerDef, TriggerRejection, VerifiedEvent } from "@valet/engine";

/**
 * Granola note webhooks. Source: https://docs.granola.ai/webhooks
 *
 * Granola signs each delivery with the Standard Webhooks scheme: HMAC-SHA256
 * over `{webhook-id}.{webhook-timestamp}.{raw body}`, keyed with the
 * base64-decoded endpoint secret (`whsec_` prefix removed). The payload
 * carries no note content, only the note ID.
 */
export const GRANOLA_EVENT_TYPES = ["note.generated", "note.edited", "note.access_granted"] as const;
type GranolaEventType = (typeof GRANOLA_EVENT_TYPES)[number];

const SECRET_PREFIX = "whsec_";
// Granola says to reject deliveries "more than a few minutes old". Retries
// carry the timestamp of the new attempt, so a late retry is still fresh.
const TIMESTAMP_TOLERANCE_SECONDS = 300;

function lookupHeader(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

/** The HMAC key, or undefined when the saved secret is not a `whsec_` base64 value. */
function signingKey(secret: string | undefined): Buffer | undefined {
  if (!secret?.startsWith(SECRET_PREFIX)) return undefined;
  const encoded = secret.slice(SECRET_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return undefined;
  const key = Buffer.from(encoded, "base64");
  return key.length > 0 ? key : undefined;
}

function signatureMatches(header: string, expected: Buffer): boolean {
  return header.split(" ").some((versioned) => {
    const [version, signature = ""] = versioned.split(",");
    const provided = Buffer.from(signature);
    return version === "v1" && provided.length === expected.length && timingSafeEqual(provided, expected);
  });
}

function parseObject(rawBody: Uint8Array): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function isEventType(v: unknown): v is GranolaEventType {
  return (GRANOLA_EVENT_TYPES as readonly unknown[]).includes(v);
}

type Inspection =
  | { ok: true; eventType: GranolaEventType; deliveryId: string; payload: Record<string, unknown> }
  | { ok: false; rejection: TriggerRejection };

const reject = (reason: TriggerRejection["reason"], detail: string): Inspection => ({ ok: false, rejection: { reason, detail } });

/**
 * Checks one delivery: signature over the raw body first, then freshness,
 * then the JSON. Nothing from the body is read or logged before the
 * signature passes.
 */
function inspect(req: { headers: Record<string, string>; rawBody: Uint8Array }, secret: string | undefined): Inspection {
  const key = signingKey(secret);
  if (!key) {
    return reject("bad_signature", "The saved Granola signing secret is missing or is not a whsec_ secret. Save the signing secret that Granola showed when it created the webhook.");
  }
  const id = lookupHeader(req.headers, "webhook-id");
  const timestamp = lookupHeader(req.headers, "webhook-timestamp");
  const signatures = lookupHeader(req.headers, "webhook-signature");
  const badSignature = "The Granola signature does not match the saved signing secret. Check that the webhook in Granola uses the saved secret, and delete other Granola webhooks that send to this URL.";
  if (!id || !timestamp || !signatures) return reject("bad_signature", badSignature);
  const signedContent = Buffer.concat([Buffer.from(`${id}.${timestamp}.`, "utf8"), Buffer.from(req.rawBody)]);
  const expected = Buffer.from(createHmac("sha256", key).update(signedContent).digest("base64"));
  if (!signatureMatches(signatures, expected)) return reject("bad_signature", badSignature);

  const seconds = /^\d{1,12}$/.test(timestamp) ? Number(timestamp) : Number.NaN;
  const ageSeconds = Math.floor(Date.now() / 1000) - seconds;
  if (!Number.isFinite(ageSeconds) || Math.abs(ageSeconds) > TIMESTAMP_TOLERANCE_SECONDS) {
    return reject("stale_delivery", `A signed Granola delivery had a timestamp ${Number.isFinite(ageSeconds) ? `${ageSeconds}s from now` : "that is not a Unix time"}. Valet accepts deliveries within ${TIMESTAMP_TOLERANCE_SECONDS}s. If this repeats, check the server clock.`);
  }

  const payload = parseObject(req.rawBody);
  if (!payload) return reject("malformed_callback", "A signed Granola delivery was not a JSON object.");
  const eventType = payload.event_type;
  if (!isEventType(eventType)) {
    const shown = typeof eventType === "string" && /^[\w.-]{1,64}$/.test(eventType) ? eventType : "an unknown event";
    return reject("unsupported_event", `Granola sent ${shown}, which Valet does not handle. Valet handles ${GRANOLA_EVENT_TYPES.join(", ")}. To stop these deliveries, remove the event from the webhook in Granola.`);
  }
  // Granola documents that `webhook-id` equals `event_id`. It is the dedupe key.
  if (payload.event_id !== id || !str(payload.note_id) || Number.isNaN(Date.parse(str(payload.occurred_at) ?? ""))) {
    return reject("malformed_callback", `A signed Granola ${eventType} delivery lacked a matching event_id, a note_id, or a valid occurred_at.`);
  }
  return { ok: true, eventType, deliveryId: id, payload };
}

const verify: TriggerDef["verify"] = (req, secrets) => {
  const result = inspect(req, secrets.signingSecret);
  return result.ok ? { eventType: result.eventType, deliveryId: result.deliveryId, payload: result.payload } : null;
};

/** Runs only after `verify` declined the request. */
const explainRejection: NonNullable<TriggerDef["explainRejection"]> = (req, secrets) => {
  const result = inspect(req, secrets.signingSecret);
  return result.ok
    ? { reason: "malformed_callback", detail: "A Granola delivery verified but was declined." }
    : result.rejection;
};

function toEvent(event: VerifiedEvent): NormalizedEvent {
  const payload = event.payload as Record<string, unknown>;
  const noteId = payload.note_id as string;
  const data = payload.data;
  const changed = typeof data === "object" && data !== null && "changed_fields" in data && Array.isArray(data.changed_fields)
    ? data.changed_fields.filter((field): field is string => typeof field === "string")
    : [];
  const refs: Record<string, string> = { note_id: noteId };
  if (changed.length) refs.changed_fields = changed.join(",");
  const verb = event.eventType.slice("note.".length).replace("_", " ");
  return {
    key: `granola.${event.eventType}`,
    dedupeKey: event.deliveryId,
    occurredAt: new Date(Date.parse(payload.occurred_at as string)).toISOString(),
    refs,
    summary: `Granola note ${noteId} ${verb}`,
    payload: event.payload,
  };
}

const DESCRIPTIONS: Record<GranolaEventType, string> = {
  "note.generated": "The first AI summary of a Granola note is generated",
  "note.edited": "A Granola note's summary is edited or regenerated",
  "note.access_granted": "A Granola note is shared with the webhook's owner",
};

export const granolaTriggerDefs: TriggerDef[] = [{
  id: "granola.note",
  service: "granola",
  description: "Granola note webhook events",
  verify,
  explainRejection,
  toEvent,
  catalog: GRANOLA_EVENT_TYPES.map((type) => ({
    key: `granola.${type}`,
    description: DESCRIPTIONS[type],
    filters: [{ field: "note_id", path: "note_id", description: "Granola note ID (for example not_1d3tmYTlCICgjy)" }],
  })),
}];
