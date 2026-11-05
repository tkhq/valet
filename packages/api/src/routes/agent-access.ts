/**
 * Agent access: the MCP apps and the `valet login` CLIs that can act as
 * the caller, and a way to disconnect each one
 * (`docs/specs/2026-10-07-mcp-agent-tools-design.md`, "Sign-in and consent").
 *
 *   GET    /api/me/agent-access
 *   DELETE /api/me/agent-access/mcp/:clientId   delete that app's tokens and consent
 *   DELETE /api/me/agent-access/cli/:id         sign out that CLI
 *
 * An agent credential cannot call the DELETE routes: they are not in `AGENT_WRITES`.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { cliTokens, oauthAccessToken, oauthApplication, oauthConsent } from "../schema/index.js";
import type { AgentAccessResponse } from "../wire/types.js";

export const agentAccessRouter = new Hono<AppEnv>();

agentAccessRouter.get("/", async (c) => {
  const { db } = c.var.providers;
  const userId = c.var.user.id;
  const tokens = await db.select({
    clientId: oauthAccessToken.clientId, name: oauthApplication.name,
    createdAt: oauthAccessToken.createdAt, refreshExpiresAt: oauthAccessToken.refreshTokenExpiresAt,
  }).from(oauthAccessToken)
    .leftJoin(oauthApplication, eq(oauthApplication.clientId, oauthAccessToken.clientId))
    .where(and(eq(oauthAccessToken.userId, userId), isNotNull(oauthAccessToken.clientId)));
  // One entry per app: the first sign-in, and the latest time any of its tokens can still refresh.
  const apps = new Map<string, AgentAccessResponse["mcp_apps"][number]>();
  for (const t of tokens) {
    if (!t.clientId) continue;
    const created = t.createdAt?.getTime() ?? null;
    const expires = t.refreshExpiresAt?.getTime() ?? null;
    const app = apps.get(t.clientId);
    if (!app) {
      apps.set(t.clientId, { client_id: t.clientId, name: t.name?.trim() || "An unnamed app", connected_at: created, expires_at: expires });
      continue;
    }
    if (created !== null && (app.connected_at === null || created < app.connected_at)) app.connected_at = created;
    if (expires !== null && (app.expires_at === null || expires > app.expires_at)) app.expires_at = expires;
  }
  const clis = await db.select().from(cliTokens).where(eq(cliTokens.userId, userId));
  const body: AgentAccessResponse = {
    mcp_apps: [...apps.values()].sort((a, b) => (b.connected_at ?? 0) - (a.connected_at ?? 0)),
    cli_devices: clis
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((t) => ({ id: t.id, device: t.device, signed_in_at: t.createdAt, last_used_at: t.lastUsedAt })),
  };
  return c.json(body);
});

agentAccessRouter.delete("/mcp/:clientId", async (c) => {
  const { db } = c.var.providers;
  const userId = c.var.user.id;
  const clientId = c.req.param("clientId");
  const removed = await db.delete(oauthAccessToken)
    .where(and(eq(oauthAccessToken.userId, userId), eq(oauthAccessToken.clientId, clientId)))
    .returning({ id: oauthAccessToken.id });
  await db.delete(oauthConsent).where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)));
  if (removed.length === 0) return c.json({ error: "That app is not connected. Reload Settings > Agent access." }, 404);
  return c.json({ ok: true });
});

agentAccessRouter.delete("/cli/:id", async (c) => {
  const removed = await c.var.providers.db.delete(cliTokens)
    .where(and(eq(cliTokens.id, c.req.param("id")), eq(cliTokens.userId, c.var.user.id)))
    .returning({ id: cliTokens.id });
  if (removed.length === 0) return c.json({ error: "That CLI is not signed in. Reload Settings > Agent access." }, 404);
  return c.json({ ok: true });
});
