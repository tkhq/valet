/**
 * `/api/org/invites` — org-admin issued signup invites (split-settings
 * design, same gating pattern as `routes/org.ts`). No route here ever
 * returns a plaintext code except the `POST` response, exactly once.
 */
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import {
  createInvite,
  listPendingInvites,
  revokeInvite,
  type InviteRole,
} from "../auth/invites.js";
import { isOrgAdmin } from "../services/org.js";
import type {
  CreateInviteRequest,
  CreateInviteResponse,
  ListInvitesResponse,
  RevokeInviteResponse,
} from "../wire/types.js";

export const orgInvitesRouter = new Hono<AppEnv>();

function isInviteRole(v: unknown): v is InviteRole {
  return v === "admin" || v === "member";
}

/** Org-admin gate applied to every route below. */
async function requireOrgAdmin(c: Context<AppEnv>) {
  const { db } = c.var.providers;
  const user = c.var.user;
  if (!(await isOrgAdmin(db, user.orgId, user.id))) {
    return c.json({ error: "org admin required" }, 403);
  }
  return undefined;
}

orgInvitesRouter.post("/", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { db } = c.var.providers;
  const user = c.var.user;

  let body: CreateInviteRequest;
  try {
    body = (await c.req.json()) as CreateInviteRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!isInviteRole(body.role)) {
    return c.json({ error: "role must be 'admin' or 'member'" }, 400);
  }
  if (body.email !== undefined && typeof body.email !== "string") {
    return c.json({ error: "email must be a string" }, 400);
  }

  const { invite, code } = await createInvite(db, {
    email: body.email,
    role: body.role,
    createdBy: user.id,
  });

  const resp: CreateInviteResponse = {
    id: invite.id,
    code,
    email: invite.email,
    role: invite.role,
    expiresAt: invite.expiresAt,
  };
  return c.json(resp);
});

orgInvitesRouter.get("/", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { db } = c.var.providers;
  const resp: ListInvitesResponse = { invites: await listPendingInvites(db) };
  return c.json(resp);
});

orgInvitesRouter.delete("/:id", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { db } = c.var.providers;
  const id = c.req.param("id");
  const revoked = await revokeInvite(db, id);
  if (!revoked) return c.json({ error: "invite not found" }, 404);

  const resp: RevokeInviteResponse = { ok: true };
  return c.json(resp);
});

export type OrgInvitesRouter = typeof orgInvitesRouter;
