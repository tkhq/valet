/**
 * `/api/org/invites` — org-admin issued signup invites (split-settings
 * design, same gating pattern as `routes/org.ts`). No route here ever
 * returns a plaintext code except the `POST` response, exactly once.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { createInvite, listPendingInvites, revokeInvite } from "../auth/invites.js";
import { isOrgRole } from "../auth/permissions.js";
import { requirePermission } from "./_org-admin.js";
import type {
  CreateInviteRequest,
  CreateInviteResponse,
  ListInvitesResponse,
  RevokeInviteResponse,
} from "../wire/types.js";

export const orgInvitesRouter = new Hono<AppEnv>();

orgInvitesRouter.post("/", async (c) => {
  const forbidden = requirePermission("members:manage")(c);
  if (forbidden) return forbidden;

  const { db } = c.var.providers;
  const user = c.var.user;

  let body: CreateInviteRequest;
  try {
    body = (await c.req.json()) as CreateInviteRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!isOrgRole(body.role)) {
    return c.json({ error: "role must be 'admin', 'operator' or 'member'" }, 400);
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
  const forbidden = requirePermission("members:manage")(c);
  if (forbidden) return forbidden;

  const { db } = c.var.providers;
  const resp: ListInvitesResponse = { invites: await listPendingInvites(db) };
  return c.json(resp);
});

orgInvitesRouter.delete("/:id", async (c) => {
  const forbidden = requirePermission("members:manage")(c);
  if (forbidden) return forbidden;

  const { db } = c.var.providers;
  const id = c.req.param("id");
  const revoked = await revokeInvite(db, id);
  if (!revoked) return c.json({ error: "invite not found" }, 404);

  const resp: RevokeInviteResponse = { ok: true };
  return c.json(resp);
});

export type OrgInvitesRouter = typeof orgInvitesRouter;
