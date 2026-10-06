import { createHmac, timingSafeEqual } from "node:crypto";
import type { EventCatalogEntry, NormalizedEvent, TriggerDef, TriggerRejection, VerifiedEvent } from "@valet/engine";

const LINEAR_TYPES = ["Issue", "Comment", "Project", "Cycle", "IssueLabel", "Reaction"] as const;
const ACTIONS = ["create", "update", "remove"] as const;
// Linear recommends ~1 minute; we allow 5 to survive clock skew and delayed
// redeliveries. True replays are already caught by the Linear-Delivery
// dedupe key, so this window only bounds crude replay attacks.
const TIMESTAMP_TOLERANCE_MS = 300_000;

function lookupHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function verifySignature(headers: Record<string, string>, rawBody: Uint8Array, secret: string): boolean {
  const signature = lookupHeader(headers, "linear-signature");
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(Buffer.from(rawBody)).digest("hex");
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

type Inspection =
  | { ok: true; type: string; action: string; deliveryId: string; payload: Record<string, unknown> }
  | { ok: false; rejection: TriggerRejection };

/** An identifier from the request, kept only if it looks like one. The body
 * is unverified when the signature fails, so nothing else from it is logged. */
function safeId(v: unknown): string | undefined {
  return typeof v === "string" && /^[\w-]{1,64}$/.test(v) ? v : undefined;
}

function parseObject(rawBody: Uint8Array): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** Checks one delivery in the order Linear documents: signature over the raw
 * body, then freshness, then the delivery header. The type and action are
 * left to the caller, which knows what it handles. */
function inspect(req: { headers: Record<string, string>; rawBody: Uint8Array }, secret: string | undefined): Inspection {
  const signed = !!secret && verifySignature(req.headers, req.rawBody, secret);
  // Parsed after the signature check. An unsigned body contributes only its
  // webhook ID, which tells an admin which Linear webhook sent it.
  const payload = parseObject(req.rawBody);
  const webhookId = safeId(payload?.webhookId);
  const from = webhookId ? ` from webhook ${webhookId}` : "";
  if (!signed) {
    return { ok: false, rejection: { reason: "bad_signature", detail: `The Linear signature${from} does not match the saved webhook signing secret. If Linear has another webhook for this URL, delete it. Otherwise copy the app's current signing secret into Organization settings > Linear.` } };
  }
  if (!payload) return { ok: false, rejection: { reason: "malformed_callback", detail: "A signed Linear delivery was not a JSON object." } };
  const type = safeId(payload.type) ?? "unknown";
  const action = safeId(payload.action) ?? "unknown";
  const rawTs = payload.webhookTimestamp;
  const tsNum = typeof rawTs === "string" ? Number(rawTs) : rawTs;
  if (typeof tsNum !== "number" || !Number.isFinite(tsNum)) {
    return { ok: false, rejection: { reason: "stale_delivery", detail: `A signed Linear ${type} ${action} delivery${from} had no webhookTimestamp, so its age is unknown.` } };
  }
  // Tolerate shape drift: some SDKs stringify large ints, and a
  // seconds-encoded timestamp (magnitude < ~1e12) would otherwise always
  // look ancient in ms terms. Coerce before the freshness check so a
  // legitimate delivery is never dropped over encoding.
  const ts = tsNum < 1e12 ? tsNum * 1000 : tsNum;
  const ageMs = Date.now() - ts;
  if (Math.abs(ageMs) > TIMESTAMP_TOLERANCE_MS) {
    return { ok: false, rejection: { reason: "stale_delivery", detail: `A signed Linear ${type} ${action} delivery${from} was ${Math.round(ageMs / 1000)}s old. Valet accepts deliveries up to ${TIMESTAMP_TOLERANCE_MS / 1000}s old. If this repeats, check the server clock.` } };
  }
  const deliveryId = lookupHeader(req.headers, "linear-delivery");
  if (!deliveryId) return { ok: false, rejection: { reason: "malformed_callback", detail: `A signed Linear ${type} ${action} delivery${from} had no Linear-Delivery header.` } };
  return { ok: true, type, action, deliveryId, payload };
}

function makeVerify(family: (typeof LINEAR_TYPES)[number]): TriggerDef["verify"] {
  return (req, secrets) => {
    const result = inspect(req, secrets.webhookSecret);
    if (!result.ok || result.type !== family || !isAction(result.action)) return null;
    return { eventType: family, deliveryId: result.deliveryId, payload: result.payload };
  };
}

function isAction(action: string): action is (typeof ACTIONS)[number] {
  return (ACTIONS as readonly string[]).includes(action);
}

/** Runs only after every family's `verify` declined the request. */
const explainRejection: NonNullable<TriggerDef["explainRejection"]> = (req, secrets) => {
  const result = inspect(req, secrets.webhookSecret);
  if (!result.ok) return result.rejection;
  const webhookId = safeId(result.payload.webhookId);
  const from = webhookId ? ` from webhook ${webhookId}` : "";
  if (result.type === "OAuthApp" && result.action === "revoked") {
    return { reason: "unsupported_event", detail: `Linear revoked the Valet app${from}. Events stop until an admin reconnects Linear in Organization settings > Linear.` };
  }
  return { reason: "unsupported_event", detail: `Linear sent ${result.type} ${result.action}${from}, which Valet does not handle. To stop these deliveries, clear that resource type on the Linear app's webhook.` };
};

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function toEvent(event: VerifiedEvent): NormalizedEvent {
  const payload = event.payload as Record<string, unknown>;
  const action = str(payload.action) ?? "unknown";
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const team = data.team as Record<string, unknown> | undefined;

  const refs: Record<string, string> = {};
  const teamKey = str(team?.key);
  if (teamKey) refs.team = teamKey;
  const identifier = str(data.identifier);
  if (identifier) refs.identifier = identifier;
  const projectId = str(data.projectId);
  if (projectId) refs.project_id = projectId;
  const url = str(payload.url);
  if (url) refs.url = url;

  const title = str(data.title) ?? str(data.body)?.slice(0, 80) ?? str(data.name) ?? "";
  const actorId = str(data.creatorId) ?? str(data.userId);
  const family = event.eventType.toLowerCase();
  return {
    key: `linear.${family}.${action}`,
    dedupeKey: event.deliveryId,
    occurredAt: str(payload.createdAt) ?? new Date().toISOString(),
    actor: actorId ? { externalId: actorId } : undefined,
    refs,
    summary: [identifier, `${family} ${action}`, title && `— ${title}`].filter(Boolean).join(" "),
    payload: event.payload,
  };
}

// The `team` filter matches on the team KEY (path ends in `.team.key`), so its
// option source resolves to team keys, not uuids. See ./filter-options.ts.
const TEAM_SOURCE = { source: "linear.teams" } as const;

const FILTERS: Record<string, EventCatalogEntry["filters"]> = {
  Issue: [
    { field: "team", path: "data.team.key", description: "Linear team key", options: TEAM_SOURCE },
    { field: "identifier", path: "data.identifier", description: "Issue identifier (e.g. TKAI-9)" },
    { field: "state", path: "data.state.name", description: "Workflow state name" },
    { field: "assignee", path: "data.assignee.name", description: "Assignee display name" },
  ],
  Comment: [{ field: "team", path: "data.issue.team.key", description: "Linear team key", options: TEAM_SOURCE }],
  Project: [{ field: "project", path: "data.name", description: "Project name" }],
  Cycle: [{ field: "team", path: "data.team.key", description: "Linear team key", options: TEAM_SOURCE }],
  IssueLabel: [{ field: "label", path: "data.name", description: "Label name" }],
  Reaction: [{ field: "emoji", path: "data.emoji", description: "Reaction emoji" }],
};

export const linearTriggerDefs: TriggerDef[] = LINEAR_TYPES.map((type) => ({
  id: `linear.${type.toLowerCase()}`,
  service: "linear",
  description: `Linear webhook event: ${type}`,
  verify: makeVerify(type),
  explainRejection,
  toEvent,
  catalog: ACTIONS.map((action) => ({
    key: `linear.${type.toLowerCase()}.${action}`,
    description: `${type.replace(/([a-z])([A-Z])/g, "$1 $2")} ${{ create: "created", update: "updated", remove: "removed" }[action]} in Linear`,
    filters: FILTERS[type] ?? [],
  })),
}));
