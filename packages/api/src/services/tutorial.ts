/**
 * The in-app tour's per-user state. The instance sets a tour version
 * (`resolveTutorialVersion`); an org admin can raise the org's own counter
 * (`orgs.tutorial_version`). A person sees the tour while they have no
 * outcome, or while either stored version is below the current one. Raising
 * a version re-shows the tour without deleting any row.
 */
import { and, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { orgs, userTutorial } from "../schema/index.js";
import type { TutorialOutcome, TutorialStateResponse, UpdateTutorialRequest } from "../wire/types.js";
import { DEFAULT_TUTORIAL_VERSION } from "../config/instance-config.js";

/** Longest step id saved for resume. Step ids are short slugs. */
const MAX_STEP_LENGTH = 64;

export class TutorialInputError extends Error {}

async function orgTutorialVersion(db: AppDb, orgId: string): Promise<number> {
  const [row] = await db.select({ tutorialVersion: orgs.tutorialVersion }).from(orgs).where(eq(orgs.id, orgId));
  return row?.tutorialVersion ?? 0;
}

/** Pure: whether the tour shows for these stored and current versions. */
export function tutorialDue(state: {
  version: number; orgVersion: number; seenVersion: number; seenOrgVersion: number; outcome: TutorialOutcome | null;
}): boolean {
  return state.outcome === null || state.seenVersion < state.version || state.seenOrgVersion < state.orgVersion;
}

export async function getTutorialState(
  db: AppDb,
  version: number | undefined,
  user: { id: string; orgId: string },
): Promise<TutorialStateResponse> {
  const current = version ?? DEFAULT_TUTORIAL_VERSION;
  const orgVersion = await orgTutorialVersion(db, user.orgId);
  const [row] = await db.select().from(userTutorial).where(eq(userTutorial.userId, user.id));
  const seenVersion = row?.seenVersion ?? 0;
  const seenOrgVersion = row?.seenOrgVersion ?? 0;
  const outcome = row?.outcome ?? null;
  const due = tutorialDue({ version: current, orgVersion, seenVersion, seenOrgVersion, outcome });
  return {
    version: current,
    orgVersion,
    seenVersion,
    seenOrgVersion,
    outcome,
    // A finished tour has no resume point. A due one resumes where the
    // person left it, but only if that step was saved for the current
    // versions: after a bump or a reset the tour starts at its first step.
    step: due && outcome === null && seenVersion === current && seenOrgVersion === orgVersion ? row?.step ?? null : null,
    due,
  };
}

function versionField(value: unknown, field: string, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TutorialInputError(`Send ${field} with ${what}: the version of the tour you show, a whole number of 0 or more.`);
  }
  return value;
}

/**
 * Save progress (`step`) or record an outcome. Each write carries the
 * versions of the tour shown, and applies only when they equal the current
 * ones: a tab left open across a version bump or an org reset cannot finish
 * or resume the newer tour. A write never lowers a stored version, and a
 * step is saved only while the tour is due, so a late progress write cannot
 * undo an outcome.
 */
export async function updateTutorial(
  db: AppDb,
  version: number | undefined,
  user: { id: string; orgId: string },
  body: UpdateTutorialRequest,
): Promise<TutorialStateResponse> {
  const current = version ?? DEFAULT_TUTORIAL_VERSION;
  const now = Date.now();
  if (body.outcome !== undefined) {
    if (body.outcome !== "completed" && body.outcome !== "skipped") {
      throw new TutorialInputError("outcome must be completed or skipped.");
    }
  } else if ("step" in body) {
    const step = body.step;
    if (step !== null && (typeof step !== "string" || step.length === 0 || step.length > MAX_STEP_LENGTH)) {
      throw new TutorialInputError(`step must be a step id of 1 to ${MAX_STEP_LENGTH} characters, or null.`);
    }
  } else {
    throw new TutorialInputError("Send step, or outcome, with the versions of the tour you show.");
  }
  const what = body.outcome !== undefined ? "outcome" : "step";
  const seen = { version: versionField(body.version, "version", what), orgVersion: versionField(body.orgVersion, "orgVersion", what) };
  const orgVersion = await orgTutorialVersion(db, user.orgId);
  if (seen.version !== current || seen.orgVersion !== orgVersion) return getTutorialState(db, version, user);

  // While a pass is in progress, the seen versions record the tour its step
  // belongs to (getTutorialState resumes only at a current step). The
  // predicates make each write a no-op if a newer write landed first: a
  // reset between the check above and this write leaves the tour due.
  const notNewer = and(lte(userTutorial.seenVersion, seen.version), lte(userTutorial.seenOrgVersion, seen.orgVersion));
  const values = body.outcome !== undefined
    ? { seenVersion: seen.version, seenOrgVersion: seen.orgVersion, outcome: body.outcome, step: null, updatedAt: now }
    : { seenVersion: seen.version, seenOrgVersion: seen.orgVersion, outcome: null, step: body.step ?? null, updatedAt: now };
  await db.insert(userTutorial).values({ userId: user.id, ...values }).onConflictDoUpdate({
    target: userTutorial.userId,
    set: values,
    setWhere: body.outcome !== undefined
      ? notNewer
      // A step only while the tour is due, so it cannot reopen a finished one.
      : and(notNewer, or(
        isNull(userTutorial.outcome),
        lt(userTutorial.seenVersion, seen.version),
        lt(userTutorial.seenOrgVersion, seen.orgVersion),
      )),
  });
  return getTutorialState(db, version, user);
}

/** Raise the org's counter so every member sees the tour on next load. */
export async function resetTutorialForOrg(db: AppDb, orgId: string): Promise<number> {
  const [row] = await db.update(orgs)
    .set({ tutorialVersion: sql`${orgs.tutorialVersion} + 1` })
    .where(eq(orgs.id, orgId))
    .returning({ tutorialVersion: orgs.tutorialVersion });
  if (!row) throw new TutorialInputError("Organization not found.");
  return row.tutorialVersion;
}
