import type { CredentialStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { resolveModelSpec } from "../services/model-resolution.js";

const checks = new WeakMap<AppDb, (orgId: string) => Promise<boolean>>();
/** Cache one resolution per org for a minute, including misses. Never read secrets on the tool path. */
export function configureTaggingAvailability(db: AppDb, credentials: CredentialStore): void {
  const cache = new Map<string, { until: number; value: Promise<boolean> }>();
  checks.set(db, orgId => {
    const old = cache.get(orgId);
    if (old && old.until > Date.now()) return old.value;
    const value = resolveModelSpec(db, credentials, orgId, "xs").then(model => !!model).catch(() => false);
    cache.set(orgId, { until: Date.now() + 60_000, value });
    return value;
  });
}
export function taggingAvailable(db: AppDb, orgId: string): Promise<boolean> {
  return checks.get(db)?.(orgId) ?? Promise.resolve(false);
}
