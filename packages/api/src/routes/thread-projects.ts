import { and, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { ThreadProjectsOperation } from "@valet/shared";
import type { AppEnv } from "../env.js";
import { requireActingUser } from "../middleware/auth.js";
import { agentSessions } from "../schema/index.js";
import { isLegacyAssistantRuntime } from "../services/legacy-runtime.js";
import { canViewSession } from "../services/session-access.js";
import { changeThreadProjects, readThreadProjects, ThreadProjectsConflict, ThreadProjectsImportConflict } from "../services/thread-projects.js";
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

async function activeThreads(c: Context<AppEnv>, session: typeof agentSessions.$inferSelect, ids: string[]): Promise<Set<string>> {
  const visible = new Set<string>();
  const checks = new Map<string, ReturnType<typeof threadsVisibleTo>>();
  const retained = new Map<string, Promise<boolean>>();
  // A workspace sidebar includes execution and migration-retained histories.
  // Resolve only the requested IDs, without loading every workspace thread.
  const execution = session.ownerType === "team" ? sql`EXISTS (
    SELECT 1 FROM assistant_executions x JOIN assistants a ON a.id = x.assistant_id
    WHERE x.session_id = s.id AND a.session_id = ${session.id} AND a.org_id = ${session.orgId}
      AND a.owner_type = ${session.ownerType} AND a.owner_id = ${session.ownerId} AND a.archived_at IS NULL
  )` : sql`false`;
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const result = await c.var.providers.db.execute(sql`SELECT t.id, t.key, s.id AS session_id, ${execution} AS execution
      FROM engine_threads t JOIN agent_sessions s ON s.id = t.session_id
      LEFT JOIN session_threads m ON m.id = t.id AND m.session_id = t.session_id
      WHERE s.org_id = ${session.orgId} AND s.owner_type = ${session.ownerType} AND s.owner_id = ${session.ownerId}
        AND s.status <> 'deleted' AND m.archived_at IS NULL AND t.status <> 'archived'
        AND (s.id = ${session.id} OR ${execution} OR (EXISTS (
          SELECT 1 FROM legacy_assistant_runtimes l WHERE l.session_id = s.id AND l.org_id = ${session.orgId}
            AND l.owner_type = ${session.ownerType} AND l.owner_id = ${session.ownerId}
        ) AND EXISTS (
          SELECT 1 FROM assistants a WHERE a.session_id = ${session.id} AND a.org_id = ${session.orgId}
            AND a.owner_type = ${session.ownerType} AND a.owner_id = ${session.ownerId} AND a.archived_at IS NULL
        )))
        AND t.id IN (${sql.join(batch.map(id => sql`${id}`), sql`, `)}) LIMIT 100`);
    const { rows } = z.object({ rows: z.array(z.object({ id: z.string(), key: z.string().nullable(), session_id: z.string(), execution: z.boolean() })) }).parse(result);
    for (const thread of rows) {
      if (thread.session_id !== session.id && !thread.execution) {
        let valid = retained.get(thread.session_id);
        if (!valid) {
          valid = isLegacyAssistantRuntime(c.var.providers.db, thread.session_id, session.orgId);
          retained.set(thread.session_id, valid);
        }
        if (!await valid) continue;
      }
      let canSee = checks.get(thread.session_id);
      if (!canSee) {
        const source = { id: thread.session_id, ownerType: session.ownerType };
        canSee = threadsVisibleTo(c, source);
        checks.set(thread.session_id, canSee);
      }
      if (await canSee(thread.key)) visible.add(thread.id);
    }
  }
  return visible;
}

threadProjectsRouter.get("/:sessionId", async c => {
  const allowed = await access(c);
  if ("error" in allowed) return allowed.error;
  const expected = c.req.query("expectedViewerId");
  if (expected !== undefined && expected !== allowed.scope.userId) {
    return c.json({ error: "Your signed-in account changed. Refresh the page to load your project folders." }, 403);
  }
  return c.json(await readThreadProjects(c.var.providers.db, allowed.scope, ids => activeThreads(c, allowed.session, ids)));
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
  const visible = await activeThreads(c, allowed.session, [...requested]);
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
  try { return c.json(await changeThreadProjects(c.var.providers.db, allowed.scope, operations, ids => activeThreads(c, allowed.session, ids))); }
  catch (error) {
    if (error instanceof ThreadProjectsImportConflict) return c.json({ error: error.message, code: error.code }, 409);
    if (error instanceof ThreadProjectsConflict) return c.json({ error: error.message }, 409);
    if (error instanceof z.ZodError) return c.json({ error: "Sidebar storage limit reached. Contact support to save this change." }, 400);
    throw error;
  }
});
