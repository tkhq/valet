import { createHmac, timingSafeEqual } from "node:crypto";
import type { EventCatalogEntry, NormalizedEvent, TriggerDef, VerifiedEvent } from "@valet/engine";

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

function makeVerify(family: (typeof LINEAR_TYPES)[number]): TriggerDef["verify"] {
  return (req, secrets) => {
    const secret = secrets.webhookSecret;
    if (!secret) return null;
    if (!verifySignature(req.headers, req.rawBody, secret)) return null;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(new TextDecoder().decode(req.rawBody)) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (payload.type !== family) return null;
    if (payload.action !== "create" && payload.action !== "update" && payload.action !== "remove") return null;
    const ts = payload.webhookTimestamp;
    if (typeof ts !== "number") return null;
    if (Math.abs(Date.now() - ts) > TIMESTAMP_TOLERANCE_MS) return null;
    const deliveryId = lookupHeader(req.headers, "linear-delivery");
    if (!deliveryId) return null;
    return { eventType: family, deliveryId, payload };
  };
}

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

const FILTERS: Record<string, EventCatalogEntry["filters"]> = {
  Issue: [
    { field: "team", path: "data.team.key", description: "Linear team key" },
    { field: "identifier", path: "data.identifier", description: "Issue identifier (e.g. TKAI-9)" },
    { field: "state", path: "data.state.name", description: "Workflow state name" },
    { field: "assignee", path: "data.assignee.name", description: "Assignee display name" },
  ],
  Comment: [{ field: "team", path: "data.issue.team.key", description: "Linear team key" }],
  Project: [{ field: "project", path: "data.name", description: "Project name" }],
  Cycle: [{ field: "team", path: "data.team.key", description: "Linear team key" }],
  IssueLabel: [{ field: "label", path: "data.name", description: "Label name" }],
  Reaction: [{ field: "emoji", path: "data.emoji", description: "Reaction emoji" }],
};

export const linearTriggerDefs: TriggerDef[] = LINEAR_TYPES.map((type) => ({
  id: `linear.${type.toLowerCase()}`,
  service: "linear",
  description: `Linear webhook event: ${type}`,
  verify: makeVerify(type),
  toEvent,
  catalog: ACTIONS.map((action) => ({
    key: `linear.${type.toLowerCase()}.${action}`,
    description: `Linear ${type} ${action}`,
    filters: FILTERS[type] ?? [],
  })),
}));
