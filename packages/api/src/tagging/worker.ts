import { gte, sql } from "drizzle-orm";
import type { CredentialStore, SessionStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { tagJobs } from "../schema/index.js";
import { recordTaggingDeadLetter } from "../observability/tagging-metrics.js";
import { configureTaggingAvailability } from "./availability.js";
import { sessionOutcomeDimension, sessionOutcomeRenderer } from "./session-outcome.js";
import { Tagger } from "./tagger.js";
import { taggingModel } from "./model.js";
import { toolIntentDimension, toolIntentRenderer } from "./tool-intent.js";

export function createTagger(db: AppDb, credentials: CredentialStore, orgId: string, store: SessionStore): Tagger {
  return new Tagger({ db, orgId, dimensions: [toolIntentDimension, sessionOutcomeDimension], classify: taggingModel(db, credentials, orgId),
    renderers: new Map([["external_call", toolIntentRenderer(db, orgId)], ["session", sessionOutcomeRenderer(db, store, orgId)]]) });
}

/** Uses EventDispatcher's existing retry rail. No timer or session reader lives here. */
export function taggingDrain(db: AppDb, credentials: CredentialStore, store: SessionStore): () => Promise<void> {
  configureTaggingAvailability(db, credentials);
  let inFlight: Promise<void> | undefined;
  return () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const dead = await db.delete(tagJobs).where(gte(tagJobs.attempts, 5)).returning({ dimension: tagJobs.dimension });
      for (const job of dead) recordTaggingDeadLetter(job.dimension);
      const dimensions = await dueTagDimensions(db);
      await Promise.all(dimensions.map(({ orgId, dimension }) => createTagger(db, credentials, orgId, store).drain(dimension)));
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  };
}

export async function dueTagDimensions(db: AppDb) {
  const result = await db.execute(sql`SELECT j.org_id AS "orgId", j.dimension FROM tag_jobs j
        LEFT JOIN tag_dimension_state s ON s.org_id = j.org_id AND s.dimension = j.dimension
        WHERE j.next_attempt_at <= ${Date.now()} AND j.attempts < 5 AND coalesce(s.lease_until, 0) <= ${Date.now()}
        GROUP BY j.org_id, j.dimension ORDER BY min(j.next_attempt_at), j.org_id, j.dimension LIMIT 4`) as { rows: { orgId: string; dimension: string }[] };
  return result.rows;

}
