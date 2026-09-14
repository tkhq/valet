import { and, eq } from "drizzle-orm";
import { LocalEvaluatorError } from "../evaluators/errors.js";
import type { AppQueryable } from "../../lib/drizzle.js";
import { policyActiveBundles, policySourceBundles } from "../../schema/index.js";
import type { ActiveBundlePointer, CanonicalSourceBundle, SourceBundleStorage } from "./types.js";

export class PostgresSourceBundleStorage implements SourceBundleStorage {
  constructor(private readonly db: AppQueryable, private readonly now: () => number = Date.now) {}

  async putIfAbsent(digest: string, bundle: CanonicalSourceBundle): Promise<"inserted" | "exists"> {
    const inserted = await this.db.insert(policySourceBundles).values({ digest, bundle, createdAt: this.now() }).onConflictDoNothing().returning({ digest: policySourceBundles.digest });
    if (inserted[0]) return "inserted";
    const existing = await this.get(digest);
    if (!existing || canonical(existing) !== canonical(bundle)) throw new LocalEvaluatorError("bundle_conflict", `Digest ${digest} already names different bytes.`);
    return "exists";
  }
  async get(digest: string): Promise<CanonicalSourceBundle | undefined> {
    return (await this.db.select({ bundle: policySourceBundles.bundle }).from(policySourceBundles).where(eq(policySourceBundles.digest, digest)).limit(1))[0]?.bundle;
  }
  async getActive(organizationId: string): Promise<ActiveBundlePointer | undefined> {
    const row = (await this.db.select().from(policyActiveBundles).where(eq(policyActiveBundles.orgId, organizationId)).limit(1))[0];
    return row && { sourceBundleDigest: row.digest, generation: row.generation };
  }
  async compareAndSetActive(organizationId: string, expected: ActiveBundlePointer | undefined, nextDigest: string): Promise<ActiveBundlePointer | undefined> {
    if (!expected) {
      const rows = await this.db.insert(policyActiveBundles).values({ orgId: organizationId, digest: nextDigest, generation: 1, activatedAt: this.now() }).onConflictDoNothing().returning();
      return rows[0] && { sourceBundleDigest: rows[0].digest, generation: rows[0].generation };
    }
    const rows = await this.db.update(policyActiveBundles).set({ digest: nextDigest, generation: expected.generation + 1, activatedAt: this.now() }).where(and(eq(policyActiveBundles.orgId, organizationId), eq(policyActiveBundles.digest, expected.sourceBundleDigest), eq(policyActiveBundles.generation, expected.generation))).returning();
    return rows[0] && { sourceBundleDigest: rows[0].digest, generation: rows[0].generation };
  }
}
function canonical(bundle: CanonicalSourceBundle): string { return JSON.stringify([bundle.manifestJson, bundle.files.map((f) => [f.path, f.contentBase64])]); }
