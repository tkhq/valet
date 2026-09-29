/** Persistence and org review policy for upstream model discoveries. */
import { and, eq } from "drizzle-orm";
import {
  detectNewModels,
  modelDiscoveryKey,
  type ModelDiscoveryState,
} from "@valet/engine/model-registry";
import { bundledModels } from "@valet/engine/model-catalog";
import type { AppQueryable } from "../lib/drizzle.js";
import {
  modelRegistryDiscoveries,
  orgModelDiscoveryReviews,
} from "../schema/index.js";
import { isRegistryModel, type RegistryModel } from "./model-registry-parse.js";

export interface ModelDiscoveryView {
  providerId: string;
  modelId: string;
  name: string;
  api: string;
  contextWindow: number;
  discoveredAt: number;
  state: ModelDiscoveryState;
}

/** Persist new upstream-only models as pending. Existing reviews stay unchanged. */
export async function recordModelDiscoveries(
  db: AppQueryable,
  providerId: string,
  upstream: readonly RegistryModel[],
  now: number = Date.now(),
): Promise<void> {
  const existing = await db
    .select({ providerId: modelRegistryDiscoveries.providerId, modelId: modelRegistryDiscoveries.modelId })
    .from(modelRegistryDiscoveries)
    .where(eq(modelRegistryDiscoveries.providerId, providerId));
  const bundled = new Set(
    bundledModels(providerId).map((model) => modelDiscoveryKey(providerId, model.id)),
  );
  const known = new Set(existing.map((row) => modelDiscoveryKey(row.providerId, row.modelId)));
  const discovered = detectNewModels(
    upstream.map((model) => ({ providerId, modelId: model.id, metadata: model })),
    bundled,
    known,
    now,
  );
  if (discovered.length === 0) return;
  await db.insert(modelRegistryDiscoveries).values(
    discovered.map((model) => ({
      providerId: model.providerId,
      modelId: model.modelId,
      metadata: model.metadata,
      discoveredAt: model.discoveredAt,
    })),
  ).onConflictDoNothing();
}

export async function listModelDiscoveries(
  db: AppQueryable,
  orgId: string,
): Promise<ModelDiscoveryView[]> {
  const discoveries = await db.select().from(modelRegistryDiscoveries);
  const reviews = await db
    .select()
    .from(orgModelDiscoveryReviews)
    .where(eq(orgModelDiscoveryReviews.orgId, orgId));
  const stateByKey = new Map(
    reviews.map((review) => [modelDiscoveryKey(review.providerId, review.modelId), review.state]),
  );
  const result: ModelDiscoveryView[] = [];
  for (const discovery of discoveries) {
    if (!isRegistryModel(discovery.metadata)) continue;
    result.push({
      providerId: discovery.providerId,
      modelId: discovery.modelId,
      name: discovery.metadata.name,
      api: discovery.metadata.api,
      contextWindow: discovery.metadata.contextWindow,
      discoveredAt: discovery.discoveredAt,
      state: stateByKey.get(modelDiscoveryKey(discovery.providerId, discovery.modelId)) ?? "pending",
    });
  }
  return result.sort((a, b) => b.discoveredAt - a.discoveredAt);
}

export async function isDiscoveredModelApproved(
  db: AppQueryable,
  orgId: string,
  providerId: string,
  modelId: string,
): Promise<boolean> {
  const discovery = await db
    .select({ modelId: modelRegistryDiscoveries.modelId })
    .from(modelRegistryDiscoveries)
    .where(and(
      eq(modelRegistryDiscoveries.providerId, providerId),
      eq(modelRegistryDiscoveries.modelId, modelId),
    ))
    .limit(1);
  if (!discovery[0]) return true;
  const approved = await approvedDiscoveredModelIds(db, orgId, providerId);
  return approved.has(modelId);
}

export async function approvedDiscoveredModelIds(
  db: AppQueryable,
  orgId: string,
  providerId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ modelId: orgModelDiscoveryReviews.modelId })
    .from(orgModelDiscoveryReviews)
    .where(and(
      eq(orgModelDiscoveryReviews.orgId, orgId),
      eq(orgModelDiscoveryReviews.providerId, providerId),
      eq(orgModelDiscoveryReviews.state, "approved"),
    ));
  return new Set(rows.map((row) => row.modelId));
}

export async function reviewModelDiscovery(
  db: AppQueryable,
  orgId: string,
  userId: string,
  providerId: string,
  modelId: string,
  state: "approved" | "rejected",
  now: number = Date.now(),
): Promise<boolean> {
  const discovery = await db
    .select({ modelId: modelRegistryDiscoveries.modelId })
    .from(modelRegistryDiscoveries)
    .where(and(
      eq(modelRegistryDiscoveries.providerId, providerId),
      eq(modelRegistryDiscoveries.modelId, modelId),
    ))
    .limit(1);
  if (!discovery[0]) return false;
  await db.insert(orgModelDiscoveryReviews).values({
    orgId, providerId, modelId, state, reviewedBy: userId, reviewedAt: now,
  }).onConflictDoUpdate({
    target: [
      orgModelDiscoveryReviews.orgId,
      orgModelDiscoveryReviews.providerId,
      orgModelDiscoveryReviews.modelId,
    ],
    set: { state, reviewedBy: userId, reviewedAt: now },
  });
  return true;
}
