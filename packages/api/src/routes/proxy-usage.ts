/**
 * `/api/proxy/usage/summary`, `/api/proxy/requests`, `/api/proxy/requests/:id`
 *
 * Read surface for the LLM recording gateway. Ownership gating:
 *   - org members see only their own rows.
 *   - org admins see all rows in their org.
 * A row outside the caller's org 404s — never 403. This avoids leaking
 * cross-org existence, matching the `llm-providers` route convention.
 *
 * Mount this router UNDER the `/api/*` auth ladder (after
 * `buildAuthMiddleware`) so `c.var.user` is always populated.
 */
import { Hono } from "hono";
import { and, desc, eq, gte, lt, lte, or, sql } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import { llmProxyRequests } from "../schema/index.js";
import { isOrgAdmin } from "../services/org.js";
import type {
  ProxyHarnessBucket,
  ProxyModelBucket,
  ProxyRequestDetail,
  ProxyRequestListItem,
  ProxyUsageSummary,
  ProxyUserBucket,
} from "../wire/types.js";

export const proxyUsageRouter = new Hono<AppEnv>();

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse the `?window=` query parameter into milliseconds. */
function parseWindowMs(window: string | undefined): number {
  if (!window) return 7 * DAY_MS;
  const m = /^(\d+)(d|h|m)$/.exec(window);
  if (!m) return 7 * DAY_MS;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case "d": return n * DAY_MS;
    case "h": return n * 60 * 60 * 1000;
    case "m": return n * 60 * 1000;
    default: return 7 * DAY_MS;
  }
}

interface AggRow {
  requests: string | number;
  input_tokens: string | number;
  output_tokens: string | number;
  total_tokens: string | number;
  cost_usd: string | number | null;
}

interface UserAggRow extends AggRow {
  user_id: string;
}

interface ModelAggRow extends AggRow {
  model: string | null;
}

interface HarnessAggRow extends AggRow {
  harness: string | null;
}

function toBucket(row: AggRow): Omit<ProxyUserBucket, "userId"> {
  return {
    requests: Number(row.requests),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    totalTokens: Number(row.total_tokens),
    costUsd: Number(row.cost_usd ?? 0),
  };
}

proxyUsageRouter.get("/usage/summary", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  const windowMs = parseWindowMs(c.req.query("window"));
  const sinceMs = Date.now() - windowMs;
  const admin = await isOrgAdmin(db, user.orgId, user.id);

  // Members see only their own rows; admins see the whole org.
  const scopeClause = admin
    ? sql`org_id = ${user.orgId}`
    : sql`org_id = ${user.orgId} AND user_id = ${user.id}`;

  // drizzle's execute() is typed `unknown` for raw SQL; narrow to the
  // node-postgres/PGlite result shape ({ rows }) by casting the awaited value,
  // matching the pattern in routes/usage.ts.
  async function aggByUser(): Promise<{ rows: UserAggRow[] }> {
    return (await db.execute(sql`
      SELECT user_id,
             COUNT(*)                AS requests,
             SUM(input_tokens)       AS input_tokens,
             SUM(output_tokens)      AS output_tokens,
             SUM(total_tokens)       AS total_tokens,
             COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM llm_proxy_requests
      WHERE created_at >= ${sinceMs}
        AND ${scopeClause}
      GROUP BY user_id
    `)) as { rows: UserAggRow[] };
  }

  async function aggByModel(): Promise<{ rows: ModelAggRow[] }> {
    return (await db.execute(sql`
      SELECT model,
             COUNT(*)                AS requests,
             SUM(input_tokens)       AS input_tokens,
             SUM(output_tokens)      AS output_tokens,
             SUM(total_tokens)       AS total_tokens,
             COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM llm_proxy_requests
      WHERE created_at >= ${sinceMs}
        AND ${scopeClause}
      GROUP BY model
    `)) as { rows: ModelAggRow[] };
  }

  async function aggByHarness(): Promise<{ rows: HarnessAggRow[] }> {
    return (await db.execute(sql`
      SELECT harness,
             COUNT(*)                AS requests,
             SUM(input_tokens)       AS input_tokens,
             SUM(output_tokens)      AS output_tokens,
             SUM(total_tokens)       AS total_tokens,
             COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM llm_proxy_requests
      WHERE created_at >= ${sinceMs}
        AND ${scopeClause}
      GROUP BY harness
    `)) as { rows: HarnessAggRow[] };
  }

  const [byUserResult, byModelResult, byHarnessResult] = await Promise.all([
    aggByUser(),
    aggByModel(),
    aggByHarness(),
  ]);

  const byUser: ProxyUserBucket[] = byUserResult.rows.map((r) => ({
    userId: r.user_id,
    ...toBucket(r),
  }));

  const byModel: ProxyModelBucket[] = byModelResult.rows.map((r) => ({
    model: r.model,
    ...toBucket(r),
  }));

  const byHarness: ProxyHarnessBucket[] = byHarnessResult.rows.map((r) => ({
    harness: r.harness,
    ...toBucket(r),
  }));

  // Compute totals by summing per-user buckets (avoids a fourth query).
  let totalRequests = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  for (const b of byUser) {
    totalRequests += b.requests;
    totalInputTokens += b.inputTokens;
    totalOutputTokens += b.outputTokens;
    totalTokens += b.totalTokens;
    totalCostUsd += b.costUsd;
  }

  const body: ProxyUsageSummary = {
    windowMs,
    totalRequests,
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    totalCostUsd,
    byUser,
    byModel,
    byHarness,
  };

  return c.json(body);
});

/** Columns the list endpoint returns (all except request/response/parsed). */
function rowToListItem(row: typeof llmProxyRequests.$inferSelect): ProxyRequestListItem {
  return {
    id: row.id,
    createdAt: row.createdAt,
    orgId: row.orgId,
    userId: row.userId,
    apiKeyId: row.apiKeyId,
    providerKind: row.providerKind,
    model: row.model ?? null,
    harness: row.harness ?? null,
    endpoint: row.endpoint,
    stream: row.stream,
    statusCode: row.statusCode,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    totalTokens: row.totalTokens,
    costUsd: row.costUsd ?? null,
    latencyMs: row.latencyMs ?? null,
    error: row.error ?? null,
  };
}

function rowToDetail(row: typeof llmProxyRequests.$inferSelect): ProxyRequestDetail {
  return {
    ...rowToListItem(row),
    requestBody: row.requestBody,
    responseBody: row.responseBody ?? null,
    parsed: row.parsed ?? null,
    parseVersion: row.parseVersion ?? null,
    parseError: row.parseError ?? null,
    providerResponseId: row.providerResponseId ?? null,
    previousResponseId: row.previousResponseId ?? null,
  };
}

proxyUsageRouter.get("/requests", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  const admin = await isOrgAdmin(db, user.orgId, user.id);

  // Query filters
  const filterUserId = c.req.query("user");
  const filterModel = c.req.query("model");
  const filterHarness = c.req.query("harness");
  const filterFrom = c.req.query("from");
  const filterTo = c.req.query("to");
  const cursor = c.req.query("cursor");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);

  // Build WHERE conditions
  const conditions = [];

  // Ownership scope
  if (admin) {
    conditions.push(eq(llmProxyRequests.orgId, user.orgId));
    if (filterUserId) {
      conditions.push(eq(llmProxyRequests.userId, filterUserId));
    }
  } else {
    conditions.push(eq(llmProxyRequests.orgId, user.orgId));
    conditions.push(eq(llmProxyRequests.userId, user.id));
  }

  if (filterModel) {
    conditions.push(eq(llmProxyRequests.model, filterModel));
  }
  if (filterHarness) {
    conditions.push(eq(llmProxyRequests.harness, filterHarness));
  }
  if (filterFrom) {
    conditions.push(gte(llmProxyRequests.createdAt, parseInt(filterFrom, 10)));
  }
  if (filterTo) {
    conditions.push(lte(llmProxyRequests.createdAt, parseInt(filterTo, 10)));
  }

  // Cursor pagination: cursor is base64-encoded JSON `{createdAt, id}`
  if (cursor) {
    try {
      const { createdAt: cursorCreatedAt, id: cursorId } = JSON.parse(
        Buffer.from(cursor, "base64").toString("utf8"),
      ) as { createdAt: number; id: string };
      conditions.push(
        or(
          lt(llmProxyRequests.createdAt, cursorCreatedAt),
          and(
            eq(llmProxyRequests.createdAt, cursorCreatedAt),
            lt(llmProxyRequests.id, cursorId),
          ),
        ),
      );
    } catch {
      // Ignore malformed cursor — start from the beginning.
    }
  }

  const rows = await db
    .select()
    .from(llmProxyRequests)
    .where(and(...conditions))
    .orderBy(desc(llmProxyRequests.createdAt), desc(llmProxyRequests.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | undefined;
  if (hasMore) {
    const last = page[page.length - 1];
    nextCursor = Buffer.from(
      JSON.stringify({ createdAt: last.createdAt, id: last.id }),
    ).toString("base64");
  }

  return c.json({ requests: page.map(rowToListItem), nextCursor });
});

proxyUsageRouter.get("/requests/:id", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const rows = await db
    .select()
    .from(llmProxyRequests)
    .where(eq(llmProxyRequests.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) return c.json({ error: "not found" }, 404);

  // A row in another org always 404s — never 403 (existence hiding).
  if (row.orgId !== user.orgId) return c.json({ error: "not found" }, 404);

  // A non-admin can only read their own rows.
  const admin = await isOrgAdmin(db, user.orgId, user.id);
  if (!admin && row.userId !== user.id) return c.json({ error: "not found" }, 404);

  return c.json(rowToDetail(row));
});
