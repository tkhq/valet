import { createHash, randomUUID } from "node:crypto";
import { and, eq, lte, or, ne } from "drizzle-orm";
import type { CredentialStore, Principal } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { workspaceBriefingCache as cache } from "../schema/index.js";
import type { WorkspaceBriefingsResponse } from "../wire/types.js";
import { canReadCachedBriefingSources } from "./workspace-briefing-cache-access.js";
import type { BriefingEvidence } from "./workspace-briefing-sources.js";

type CacheRow = typeof cache.$inferSelect;

/** Ordering and workflow heartbeats do not change the facts sent to the model. */
export function briefingEvidenceHash(evidence: readonly BriefingEvidence[]): string {
  const stable = evidence.map(item => {
    const { updatedAt, ...source } = item.source;
    return { ...item, source: { ...source, ...(source.kind === "thread" ? { updatedAt } : {}) } };
  }).sort((a,b) => a.source.id.localeCompare(b.source.id));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
/** What brief generation needs to reach the organization's own models and keys. */
export interface BriefingModelAccess {
  db: AppDb;
  credentials?: CredentialStore;
}

interface CacheOptions {
  version: string;
  collect: (db: AppDb, orgId: string, owner: Principal) => Promise<BriefingEvidence[]>;
  generate: (orgId: string, owner: Principal, evidence: readonly BriefingEvidence[], access: BriefingModelAccess) => Promise<WorkspaceBriefingsResponse>;
  validate?: typeof canReadCachedBriefingSources;
  now?: () => number;
  checkIntervalMs?: number;
  failureBackoffMs?: number;
  /** Return a preparing response while slow collection/generation continues. */
  requestWaitMs?: number;
  leaseMs?: number;
  /** Minimum age of a shown snapshot before changed evidence regenerates it. */
  minRegenerateMs?: number;
}

/** Route authorization runs on every GET. Evidence checks run at most once per minute.
 * Atomic leases serialize those checks and generation across API replicas.
 *
 * When a snapshot of the current version exists, changed evidence regenerates it in
 * the background and the GET returns the old snapshot marked `refreshing`. Showing it
 * is safe because every read re-checks that the caller can still read each source.
 * A snapshot younger than `minRegenerateMs` is kept without repeating collection.
 * Cold requests wait briefly, then return
 * refreshing while the lease holder continues collection and generation. */
export function createDurableBriefingCache(options: CacheOptions) {
  const validate = options.validate ?? canReadCachedBriefingSources;
  const now = options.now ?? Date.now;
  const interval = options.checkIntervalMs ?? 60_000;
  const backoff = options.failureBackoffMs ?? 60_000;
  const leaseMs = options.leaseMs ?? 30_000;
  const minRegenerate = options.minRegenerateMs ?? 5 * 60_000;
  const unavailable = (checkedAt: number | null, refreshing = false): WorkspaceBriefingsResponse => ({
    briefings: [], generatedAt: null, coverage: "recent", unavailable: true, checkedAt,
    ...(refreshing ? { refreshing: true } : {}),
  });
  return async (db: AppDb, orgId: string, owner: Principal, credentials?: CredentialStore): Promise<WorkspaceBriefingsResponse> => {
    const scope = and(eq(cache.orgId,orgId),eq(cache.ownerType,owner.type),eq(cache.ownerId,owner.id));
    const visible = async (row: CacheRow | undefined): Promise<WorkspaceBriefingsResponse> => {
      const refreshing = !!row?.leaseToken && row.leaseUntil > now();
      if (!row || row.version !== options.version || !row.response) return unavailable(row?.checkedAt ?? null,refreshing);
      if (!await validate(db,orgId,owner,row.response)) {
        await db.update(cache).set({ response: null, evidenceHash: null, nextCheckAt: 0 })
          .where(and(scope,eq(cache.version,row.version),row.evidenceHash === null ? undefined : eq(cache.evidenceHash,row.evidenceHash)));
        return unavailable(row.checkedAt,refreshing);
      }
      return { ...row.response, checkedAt: row.checkedAt, ...(refreshing ? { refreshing: true } : {}) };
    };
    const read = async () => (await db.select().from(cache).where(scope).limit(1))[0];
    const existing = await read();
    const at = now();
    if (existing?.version === options.version && (existing.nextCheckAt > at
      || (existing.response?.generatedAt != null && at - existing.response.generatedAt < minRegenerate))) {
      // No evidence can trigger generation during this window. Still recheck access
      // on every read, and leave checkedAt at the last actual collection time.
      return visible(existing);
    }
    const token = randomUUID();
    const [claimed] = await db.insert(cache).values({ orgId, ownerType: owner.type, ownerId: owner.id,
      version: options.version, leaseToken: token, leaseUntil: at+leaseMs,
    }).onConflictDoUpdate({ target: [cache.orgId,cache.ownerType,cache.ownerId],
      set: { leaseToken: token, leaseUntil: at+leaseMs },
      setWhere: and(lte(cache.leaseUntil,at),or(lte(cache.nextCheckAt,at),ne(cache.version,options.version))),
    }).returning();
    if (!claimed) return visible(await read());
    // Ownership is the token, not the deadline. If no replica reclaimed an
    // expired lease, the original worker may still publish instead of losing work.
    const fence = () => and(scope,eq(cache.leaseToken,token));
    let background = false;
    const renewal = setInterval(() => {
      void db.update(cache).set({ leaseUntil: now()+leaseMs }).where(fence())
        .catch(err => console.error("workspace briefing lease renewal failed:", err));
    }, Math.max(10, Math.floor(leaseMs/3)));
    renewal.unref();
    const work = (async () => {
      try {
        const evidence = await measured("collection", () => options.collect(db,orgId,owner));
        const evidenceHash = briefingEvidenceHash(evidence);
        const checkedAt = now();
        if (claimed.version === options.version && claimed.evidenceHash === evidenceHash && claimed.response) {
          const [row] = await db.update(cache).set({ checkedAt, nextCheckAt: checkedAt+interval,
            leaseToken: null, leaseUntil: 0 }).where(fence()).returning();
          return visible(row ?? await read());
        }
        const shown = claimed.version === options.version ? claimed.response : null;
        if (shown) {
          background = true;
          void regenerate(evidence, evidenceHash, checkedAt, true);
          return visible(claimed);
        }
        // No snapshot yet: publish it when ready; slow requests return refreshing.
        const [invalidated] = await db.update(cache).set({ version: options.version, response: null,
          evidenceHash: null, checkedAt }).where(fence()).returning();
        if (!invalidated) return visible(await read());
        return await regenerate(evidence, evidenceHash, checkedAt, false);
      } catch (err) {
        return await fail(err, claimed.version === options.version && !!claimed.response);
      } finally {
        if (!background) clearInterval(renewal);
      }
    })();
    let responseTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<WorkspaceBriefingsResponse>(resolve => {
          responseTimer = setTimeout(() => resolve(visible(claimed)), options.requestWaitMs ?? 2000);
          responseTimer.unref();
        }),
      ]);
    } finally {
      clearTimeout(responseTimer);
    }

    async function measured<T>(stage: "collection" | "generation", action: () => Promise<T>): Promise<T> {
      const started = performance.now();
      let outcome = "threw";
      try {
        const result = await action();
        outcome = "returned";
        return result;
      } finally {
        console.info("workspace briefing stage", { orgId, ownerType: owner.type, ownerId: owner.id,
          stage, durationMs: Math.round(performance.now()-started), outcome });
      }
    }

    async function regenerate(evidence: BriefingEvidence[], evidenceHash: string, checkedAt: number, keepShown: boolean) {
      try {
        let response = evidence.length ? await measured("generation", () => options.generate(orgId,owner,evidence,{ db, ...(credentials ? { credentials } : {}) }))
          : { briefings: [], generatedAt: null, coverage: "recent" as const };
        if (!response.unavailable && !await validate(db,orgId,owner,response)) response = unavailable(checkedAt);
        if (response.unavailable && keepShown) return await fail(new Error("Briefing generation was unavailable."), true);
        const [published] = await db.update(cache).set({ evidenceHash: response.unavailable ? null : evidenceHash,
          response: response.unavailable ? null : response, checkedAt, nextCheckAt: response.unavailable ? now()+backoff : checkedAt+interval,
          leaseToken: null, leaseUntil: 0 }).where(fence()).returning();
        return visible(published ?? await read());
      } catch (err) {
        return await fail(err, keepShown);
      } finally {
        clearInterval(renewal);
      }
    }

    async function fail(err: unknown, keepShown: boolean) {
      console.error("workspace briefing refresh failed:", err);
      // A failed refresh keeps a snapshot that is still shown; each read re-checks its
      // sources. A failed first generation shows nothing. Both retry after the backoff.
      const [failed] = await db.update(cache).set({ version: options.version,
        ...(keepShown ? {} : { evidenceHash: null, response: null }),
        nextCheckAt: now()+backoff, leaseToken: null, leaseUntil: 0 }).where(fence()).returning();
      return visible(failed ?? await read());
    }
  };
}
