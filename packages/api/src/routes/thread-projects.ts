import { and, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { ThreadProjectsOperation } from "@valet/shared";
import type { AppEnv } from "../env.js";
import { requireActingUser } from "../middleware/auth.js";
import { agentSessions } from "../schema/index.js";
import { canViewSession } from "../services/session-access.js";
import { changeThreadProjects, readThreadProjects, ThreadProjectsConflict } from "../services/thread-projects.js";
import { threadProjectsMutationSchema } from "../services/thread-projects-schema.js";
import { spawnedFromVisibleThread, threadsVisibleTo } from "./_thread-access.js";

export const threadProjectsRouter = new Hono<AppEnv>();
threadProjectsRouter.use("/*", bodyLimit({ maxSize: 2 * 1024 * 1024,
  onError: c => c.json({ error: "Sidebar data exceeds 2 MiB. Import fewer folders or chats at one time." }, 413) }));

async function access(c: Context<AppEnv>) {
  const user = requireActingUser(c);
  if (!user) return { error: c.json({ error: "Sign in to manage your project folders." }, 403) };
  const sessionId = c.req.param("sessionId");
  const [session] = await c.var.providers.db.select().from(agentSessions)
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.orgId, user.orgId))).limit(1);
  if (!session || !await canViewSession(c.var.providers.db, session, c.var.principal)
    || !await spawnedFromVisibleThread(c, session)) return { error: c.json({ error: "Workspace not found. Choose an available workspace." }, 404) };
  return { scope: { orgId: user.orgId, userId: user.id, sessionId }, session };
}

threadProjectsRouter.get("/:sessionId", async c => {
  const allowed = await access(c);
  if ("error" in allowed) return allowed.error;
  const expected = c.req.query("expectedViewerId");
  if (expected !== undefined && expected !== allowed.scope.userId) {
    return c.json({ error: "Your signed-in account changed. Refresh the page to load your project folders." }, 403);
  }
  return c.json(await readThreadProjects(c.var.providers.db, allowed.scope));
});

threadProjectsRouter.patch("/:sessionId", async c => {
  const allowed = await access(c);
  if ("error" in allowed) return allowed.error;
  let body: unknown;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "Send a JSON object with sidebar operations." }, 400); }
  const parsed = threadProjectsMutationSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid sidebar change. Use at most 200 folders, 5000 chats, and names of 100 characters or fewer." }, 400);
  if (parsed.data.expectedViewerId !== allowed.scope.userId) {
    return c.json({ error: "Your signed-in account changed. Reopen the original account before you retry this sidebar change." }, 403);
  }

  const requested = new Set<string>();
  for (const op of parsed.data.operations) {
    if (op.type === "assign" || op.type === "pin") requested.add(op.threadId);
    if (op.type === "import") {
      Object.keys(op.value.assignments).forEach(id => requested.add(id));
      op.value.pinned.forEach(id => requested.add(id));
    }
  }
  if (requested.size > 5000) return c.json({ error: "Too many chats in one sidebar change. Save at most 5000 chats at one time." }, 400);
  const visible = new Set<string>();
  const ids = [...requested];
  const canSee = threadsVisibleTo(c, allowed.session);
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const result = await c.var.providers.db.execute(sql`SELECT id, key FROM engine_threads
      WHERE session_id = ${allowed.scope.sessionId} AND id IN (${sql.join(batch.map(id => sql`${id}`), sql`, `)}) LIMIT 100`);
    const { rows } = z.object({ rows: z.array(z.object({ id: z.string(), key: z.string().nullable() })) }).parse(result);
    for (const thread of rows) if (await canSee(thread.key)) visible.add(thread.id);
  }
  const operations: ThreadProjectsOperation[] = [];
  for (const op of parsed.data.operations) {
    if ((op.type === "assign" || op.type === "pin") && !visible.has(op.threadId)) {
      return c.json({ error: "Chat not found. Refresh the sidebar and choose an available chat." }, 404);
    }
    if (op.type === "import") operations.push({ type: "import", value: { ...op.value,
      assignments: Object.fromEntries(Object.entries(op.value.assignments).filter(([id]) => visible.has(id))),
      pinned: op.value.pinned.filter(id => visible.has(id)),
    } });
    else operations.push(op);
  }
  try { return c.json(await changeThreadProjects(c.var.providers.db, allowed.scope, operations)); }
  catch (error) {
    if (error instanceof ThreadProjectsConflict) return c.json({ error: error.message }, 409);
    if (error instanceof z.ZodError) return c.json({ error: "Sidebar storage limit reached. Contact support to save this change." }, 400);
    throw error;
  }
});
