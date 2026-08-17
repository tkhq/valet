/**
 * Assistants — the named agents a principal owns.
 *
 *   GET    /api/assistants        → list, optionally filtered by owner
 *   POST   /api/assistants        → create one
 *   PATCH  /api/assistants/:id    → rename, or promote to default
 *   DELETE /api/assistants/:id    → archive (never destroy)
 *
 * Authorization is the session rule, unchanged: reading follows
 * `canViewSession`'s team-membership rule and administering follows
 * `canAdministerSession`, both reached through `assistants/access.ts`. A
 * caller who fails either check gets 404, matching `routes/teams.ts` —
 * existence-hiding applies to authorization, not only to org membership.
 *
 * Listing is the only way a client learns an assistant's `sessionId`, and
 * it creates nothing: browsing the list starts no agent. The one exception
 * to "listing creates nothing" is `GET /api/orchestrator/info`, which
 * resolves the caller's default assistant because its whole answer is about
 * that one row.
 */
import { Hono } from "hono";
import type { Principal } from "@valet/engine";
import type { AppEnv } from "../env.js";
import {
  archiveAssistant,
  ArchivedAssistantError,
  createAssistant,
  DefaultAssistantArchiveError,
  ensureAssistantSession,
  listAssistantsForOwners,
  loadAssistant,
  patchAssistant,
  toAssistantSummary,
} from "../assistants/service.js";
import { assistantOwner, canAdministerAssistantOwner, canViewAssistantOwner } from "../assistants/access.js";
import { listTeamsForUser } from "../services/teams.js";
import type {
  AssistantOwner,
  CreateAssistantRequest,
  CreateAssistantResponse,
  ListAssistantsResponse,
  PatchAssistantRequest,
  PatchAssistantResponse,
  EnsureAssistantSessionResponse,
} from "../wire/types.js";

export const assistantsRouter = new Hono<AppEnv>();

const OWNER_TYPES: ReadonlySet<string> = new Set(["user", "team", "org"]);

function isOwnerType(value: string): value is AssistantOwner["type"] {
  return OWNER_TYPES.has(value);
}

/** The `?ownerType=&ownerId=` filter, or undefined when absent. Returns an
 * error string when one half is present and the other is not. */
function readOwnerFilter(
  ownerType: string | undefined,
  ownerId: string | undefined,
): { owner?: Principal; error?: string } {
  if (ownerType === undefined && ownerId === undefined) return {};
  if (ownerType === undefined || ownerId === undefined) {
    return { error: "Filter by owner with both ownerType and ownerId, or send neither." };
  }
  if (!isOwnerType(ownerType)) {
    return { error: "ownerType must be 'user', 'team' or 'org'." };
  }
  return { owner: { type: ownerType, id: ownerId } };
}

// ── List ──────────────────────────────────────────────────────────────────

/**
 * Without a filter this returns every assistant the caller can reach: their
 * own, plus one entry per team they belong to. Org-owned assistants are not
 * included — `canViewSession` admits nobody to an org-owned session, and
 * this route does not invent a rule that check does not have.
 */
assistantsRouter.get("/", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  const filter = readOwnerFilter(c.req.query("ownerType"), c.req.query("ownerId"));
  if (filter.error) return c.json({ error: filter.error }, 400);

  if (filter.owner) {
    if (!(await canViewAssistantOwner(db, filter.owner, user.id))) {
      return c.json({ error: "owner not found" }, 404);
    }
    const rows = await listAssistantsForOwners(db, user.orgId, [filter.owner]);
    const body: ListAssistantsResponse = { assistants: rows.map(toAssistantSummary) };
    return c.json(body);
  }

  const teams = await listTeamsForUser(db, user.id);
  const owners: Principal[] = [
    { type: "user", id: user.id },
    ...teams.filter((t) => t.orgId === user.orgId).map((t): Principal => ({ type: "team", id: t.id })),
  ];
  const rows = await listAssistantsForOwners(db, user.orgId, owners);
  const body: ListAssistantsResponse = { assistants: rows.map(toAssistantSummary) };
  return c.json(body);
});

// ── Create ────────────────────────────────────────────────────────────────

assistantsRouter.post("/", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  let body: CreateAssistantRequest;
  try {
    body = (await c.req.json()) as CreateAssistantRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  let owner: Principal = { type: "user", id: user.id };
  if (body.owner !== undefined) {
    if (typeof body.owner.id !== "string" || body.owner.id.length === 0 || !isOwnerType(body.owner.type)) {
      return c.json({ error: "owner must be { type: 'user' | 'team' | 'org', id }." }, 400);
    }
    owner = { type: body.owner.type, id: body.owner.id };
  }
  if (body.name !== undefined && typeof body.name !== "string") {
    return c.json({ error: "name must be a string." }, 400);
  }

  if (!(await canAdministerAssistantOwner(db, owner, user.id))) {
    return c.json({ error: "owner not found" }, 404);
  }

  const row = await createAssistant(db, user.orgId, owner, body.name ?? null);
  const response: CreateAssistantResponse = toAssistantSummary(row);
  return c.json(response, 201);
});

// ── Patch (rename / promote) ──────────────────────────────────────────────

assistantsRouter.patch("/:id", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  let body: PatchAssistantRequest;
  try {
    body = (await c.req.json()) as PatchAssistantRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (body.name !== undefined && typeof body.name !== "string") {
    return c.json({ error: "name must be a string." }, 400);
  }
  if (body.isDefault !== undefined && body.isDefault !== true) {
    return c.json(
      { error: "isDefault can only be set to true. To change the default, promote another assistant." },
      400,
    );
  }
  if (body.name === undefined && body.isDefault === undefined) {
    return c.json({ error: "Send a name, or isDefault: true." }, 400);
  }

  const row = await loadAssistant(db, c.req.param("id"));
  if (!row || row.orgId !== user.orgId) return c.json({ error: "assistant not found" }, 404);
  if (!(await canAdministerAssistantOwner(db, assistantOwner(row), user.id))) {
    return c.json({ error: "assistant not found" }, 404);
  }

  try {
    const updated = await patchAssistant(db, row, body);
    const response: PatchAssistantResponse = toAssistantSummary(updated);
    return c.json(response);
  } catch (err) {
    if (err instanceof ArchivedAssistantError) {
      return c.json({ error: err.message, code: err.code }, err.statusCode);
    }
    throw err;
  }
});

// ── Open (get-or-create the session) ──────────────────────────────────────

/**
 * `POST /api/assistants/:id/session` — get-or-create this assistant's
 * session, and return its id.
 *
 * Creating an assistant writes only the `assistants` row, so a new one has
 * no session until somebody opens it. Every ordinary session route reads the
 * `agent_sessions` app row, so without this call a freshly created assistant
 * lists correctly and then 404s on the first click.
 *
 * Idempotent, and safe to call on every mount — it is the same get-or-create
 * `POST /api/orchestrator` performs for a principal's default, addressed by
 * assistant instead. Reading is enough to earn it: anyone who may view the
 * assistant may open the conversation.
 */
assistantsRouter.post("/:id/session", async (c) => {
  const { db, engineHost } = c.var.providers;
  const user = c.var.user;

  const row = await loadAssistant(db, c.req.param("id"));
  if (!row || row.orgId !== user.orgId) return c.json({ error: "assistant not found" }, 404);
  if (!(await canViewAssistantOwner(db, assistantOwner(row), user.id))) {
    return c.json({ error: "assistant not found" }, 404);
  }
  if (row.archivedAt !== null) {
    return c.json(
      { error: "This assistant is archived. Restore it before opening the conversation." },
      409,
    );
  }

  const { sessionId } = await ensureAssistantSession({ db, engineHost }, row, {
    actorUserId: user.id,
    orgId: user.orgId,
  });
  const body: EnsureAssistantSessionResponse = { sessionId };
  return c.json(body);
});

// ── Archive ───────────────────────────────────────────────────────────────

/** Archives rather than destroys: the conversation the assistant held stays
 * readable through its session id. */
assistantsRouter.delete("/:id", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  const row = await loadAssistant(db, c.req.param("id"));
  if (!row || row.orgId !== user.orgId) return c.json({ error: "assistant not found" }, 404);
  if (!(await canAdministerAssistantOwner(db, assistantOwner(row), user.id))) {
    return c.json({ error: "assistant not found" }, 404);
  }

  try {
    await archiveAssistant(db, row);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof DefaultAssistantArchiveError) {
      return c.json({ error: err.message, code: err.code }, err.statusCode);
    }
    throw err;
  }
});
