import { and, eq, gt, lt, isNotNull } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { priceUsage, resolveCanonicalModel } from "../lib/pricing.js";
import { llmProxyRequests } from "../schema/index.js";

/** Explicit repair using current catalog rates. Dry-run unless apply is true.
 * Token fields keep their provider semantics. Only stored estimates change. */
export async function repriceProxyCalls(
  db: AppDb,
  opts: { orgId: string; beforeMs: number; apply: boolean },
): Promise<{ changed: number; skipped: number; oldCostUsd: number; newCostUsd: number }> {
  const result = { changed: 0, skipped: 0, oldCostUsd: 0, newCostUsd: 0 };
  let cursor = "";
  for (;;) {
    const rows = await db.select({
      id: llmProxyRequests.id, model: llmProxyRequests.model, requestBody: llmProxyRequests.requestBody,
      input: llmProxyRequests.inputTokens, output: llmProxyRequests.outputTokens,
      cacheRead: llmProxyRequests.cacheReadTokens, cacheWrite: llmProxyRequests.cacheWriteTokens,
      total: llmProxyRequests.totalTokens, cost: llmProxyRequests.costUsd,
    }).from(llmProxyRequests).where(and(
      eq(llmProxyRequests.orgId, opts.orgId), eq(llmProxyRequests.providerKind, "openai"),
      lt(llmProxyRequests.createdAt, opts.beforeMs), gt(llmProxyRequests.cacheReadTokens, 0),
      isNotNull(llmProxyRequests.costUsd), gt(llmProxyRequests.id, cursor),
    )).orderBy(llmProxyRequests.id).limit(500);
    if (rows.length === 0) break;
    for (const row of rows) {
      let model = row.model ? resolveCanonicalModel("openai", row.model) : null;
      if (!model) {
        try {
          const request: unknown = JSON.parse(row.requestBody);
          if (request && typeof request === "object" && "model" in request && typeof request.model === "string") {
            model = resolveCanonicalModel("openai", request.model);
          }
        } catch { /* An unreadable request cannot supply a pricing fallback. */ }
      }
      const cost = model ? priceUsage("openai", model, row) : null;
      if (cost === null || row.cost === null) { result.skipped++; continue; }
      if (Math.abs(cost - row.cost) < 1e-12) continue;
      if (opts.apply) {
        // Compare the old value to avoid overwriting a concurrent repair.
        const updated = await db.update(llmProxyRequests).set({ costUsd: cost }).where(and(
          eq(llmProxyRequests.id, row.id), eq(llmProxyRequests.costUsd, row.cost),
        )).returning({ id: llmProxyRequests.id });
        if (updated.length === 0) { result.skipped++; continue; }
      }
      result.changed++;
      result.oldCostUsd += row.cost;
      result.newCostUsd += cost;
    }
    cursor = rows[rows.length - 1].id;
  }
  return result;
}
