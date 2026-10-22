import { and, lt, lte } from "drizzle-orm";
import type { CredentialStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { tagJobs } from "../schema/index.js";
import { Tagger } from "./tagger.js";
import { taggingModel } from "./model.js";
import { toolIntentDimension, toolIntentRenderer } from "./tool-intent.js";

export function createTagger(db: AppDb, credentials: CredentialStore, orgId: string): Tagger {
  return new Tagger({ db, orgId, dimensions: [toolIntentDimension], classify: taggingModel(db, credentials, orgId),
    renderers: new Map([["external_call", toolIntentRenderer(db, orgId)]]) });
}

/** Uses EventDispatcher's existing retry rail. No timer or session reader lives here. */
export function taggingDrain(db: AppDb, credentials: CredentialStore): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  return () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const dimensions = await db.selectDistinct({ orgId: tagJobs.orgId, dimension: tagJobs.dimension }).from(tagJobs)
        .where(and(lte(tagJobs.nextAttemptAt, Date.now()), lt(tagJobs.attempts, 5))).limit(4);
      await Promise.all(dimensions.map(({ orgId, dimension }) => createTagger(db, credentials, orgId).drain(dimension)));
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
