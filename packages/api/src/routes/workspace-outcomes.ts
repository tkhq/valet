import { decryptSecret, deriveSecretKey, encryptSecret } from "../lib/secret-crypto.js";
import { and, eq, inArray } from "drizzle-orm";
import { workflowRuns } from "../schema/index.js";
import { runEventVisible } from "../services/thread-access.js";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { decodePageCursor, readLimit } from "../lib/page-cursor.js";
import { listWorkspaceOutcomes, type OutcomeCursor } from "../services/workspace-outcomes.js";
import { authorizedWorkspaceOwner } from "./workspace-runtime.js";
import { keepVisibleThreads, viewerOf } from "./_thread-access.js";

export const workspaceOutcomesRouter = new Hono<AppEnv>();
workspaceOutcomesRouter.get("/:workspace/outcomes", async c => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  const limit = readLimit(c.req.query("limit"), 25, 100);
  if (limit === undefined) return c.json({ error: "Invalid limit. Use a positive whole number." }, 400);
  let cursor: OutcomeCursor | undefined;
  const cursorKey = deriveSecretKey(`outcomes-cursor:${c.var.providers.encryptionKey}`);
  let raw = c.req.query("cursor");
  if (raw?.startsWith("sealed:")) {
    try {
      raw = raw.length <= 4096 ? decryptSecret(Buffer.from(raw.slice(7), "base64url").toString("utf8"), cursorKey) : "invalid";
    } catch { raw = "invalid"; }
  }
  if (raw !== undefined) {
    const parsed = raw.length <= 4096 ? decodePageCursor(raw) : undefined;
    if (!parsed || parsed.feed !== "outcomes" || parsed.orgId !== c.var.user.orgId || parsed.ownerType !== owner.type || parsed.ownerId !== owner.id
      || typeof parsed.at !== "number" || !Number.isSafeInteger(parsed.at) || parsed.at < 0
      || typeof parsed.id !== "string" || !parsed.id || parsed.id.length > 1024) {
      return c.json({ error: "Invalid cursor. Reload the outcomes list." }, 400);
    }
    cursor = { at: parsed.at, id: parsed.id };
  }
  const page = await listWorkspaceOutcomes(c.var.providers.db, c.var.user.orgId, owner, limit, cursor);
  let items = await keepVisibleThreads(c, owner, page.items);
  const runIds = [...new Set(items.flatMap(item => item.workflowRunId ? [item.workflowRunId] : []))];
  if (owner.type === "team" && runIds.length) {
    // Event-only runs have no origin thread. Check their source channel too.
    // A run carries its org, so a deleted workflow's outcomes stay visible.
    const runs = await c.var.providers.db.select({ id: workflowRuns.id, params: workflowRuns.params })
      .from(workflowRuns)
      .where(and(inArray(workflowRuns.id, runIds), eq(workflowRuns.orgId, c.var.user.orgId),
        eq(workflowRuns.ownerType, "team"), eq(workflowRuns.ownerId, owner.id)));
    const visible = new Set<string>();
    for (const run of runs) {
      if (!run.params || typeof run.params !== "object" || !("input" in run.params)) {
        // Scheduled and manually started runs need not carry event input.
        if (run.params && typeof run.params === "object") visible.add(run.id);
        continue;
      }
      if (await runEventVisible(c.var.providers, viewerOf(c), { input: run.params.input })) visible.add(run.id);
    }
    items = items.filter(item => !item.workflowRunId || visible.has(item.workflowRunId));
  }
  // Filtering may hide the last row. Do not expose its id or timestamp in a cursor.
  const nextCursor = owner.type === "team" && page.nextCursor
    ? `sealed:${Buffer.from(encryptSecret(page.nextCursor, cursorKey)).toString("base64url")}` : page.nextCursor;
  return c.json({ items, nextCursor });
});
