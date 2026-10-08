import { NoCredentialsError, type CreateSessionOptions, type CredentialStore, type ResolvedModel } from "@valet/engine";
import type { AppQueryable } from "../lib/drizzle.js";
import { parseModelId } from "./llm-providers.js";
import { buildOrgCatalog } from "./model-catalog.js";
import { resolveModelSpec } from "./model-resolution.js";
import { getOrgTierMap, TIER_TOKENS } from "./model-tiers.js";

type FallbackRequest = Parameters<NonNullable<CreateSessionOptions["resolveFallbackModel"]>>[0];

function canonical(spec: string): string {
  const { namespace, modelId } = parseModelId(spec);
  return `${namespace}/${modelId}`;
}

/** Recovery stays within the organization's ordered tier targets. A concrete
 * selection uses its first matching tier; an unmatched selection has no fallback.
 * No registry-order guesses, new credentials, or model-policy bypasses. */
export async function resolveModelFallback(
  db: AppQueryable | undefined,
  credentials: CredentialStore,
  orgId: string,
  request: FallbackRequest,
): Promise<ResolvedModel | null> {
  if (!db) return null;
  const [tiers, catalog] = await Promise.all([getOrgTierMap(db, orgId), buildOrgCatalog(db, credentials, orgId)]);
  const requested = request.requestedSpec.trim().toLowerCase();
  const tier = TIER_TOKENS.find(value => value === requested)
    ?? TIER_TOKENS.find(value => tiers[value].some(spec => canonical(spec) === canonical(request.requestedSpec)));
  if (!tier) return null;
  const eligible = new Set(catalog.filter(entry => entry.active && entry.resolvable && entry.approved).map(entry => entry.id));
  const attempted = new Set([...request.attemptedProviderIds, request.failedModel.model.provider]);
  for (const spec of tiers[tier]) {
    if (!eligible.has(canonical(spec)) || attempted.has(parseModelId(spec).namespace)) continue;
    try {
      // Re-read provider state and credentials; a rotated key takes effect now.
      const resolved = await resolveModelSpec(db, credentials, orgId, spec);
      if (!resolved || attempted.has(resolved.model.provider)) continue;
      // Retain input capabilities when continuing an existing transcript.
      if (!request.failedModel.model.input.every(kind => resolved.model.input.includes(kind))) continue;
      return resolved;
    } catch (error) {
      // A removed/blank credential is not permission to use an ambient key.
      if (!(error instanceof NoCredentialsError)) throw error;
    }
  }
  return null;
}
