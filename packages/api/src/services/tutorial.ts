/**
 * The in-app tour's per-user state. The instance sets a tour version
 * (`resolveTutorialVersion`); an org admin can raise the org's own counter
 * (`orgs.tutorial_version`). A person sees the tour while they have no
 * outcome, or while either stored version is below the current one. Raising
 * a version re-shows the tour without deleting any row.
 */
import { eq, isNull, lt, or, sql } from "drizzle-orm";
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

function versionField(value: unknown, field: string, cap: number): number {
  if (value === undefined) return cap;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TutorialInputError(`${field} must be a whole number of 0 or more.`);
  }
  return Math.min(value, cap);
}

/**
 * Save progress (`step`) or record an outcome. An outcome stamps the versions
 * the person saw, capped at the current ones, and clears the resume point.
 * A step is saved only while the tour is due and only for the current
 * versions, so a late progress write cannot undo an outcome or carry a
 * resume point into a newer tour.
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
    const orgVersion = await orgTutorialVersion(db, user.orgId);
    const values = {
      userId: user.id,
      seenVersion: versionField(body.version, "version", current),
      seenOrgVersion: versionField(body.orgVersion, "orgVersion", orgVersion),
      outcome: body.outcome,
      step: null,
      updatedAt: now,
    };
    await db.insert(userTutorial).values(values).onConflictDoUpdate({
      target: userTutorial.userId,
      // Never lower a stored version: a stale tab must not re-show the tour.
      set: {
        seenVersion: sql`GREATEST(${userTutorial.seenVersion}, ${values.seenVersion})`,
        seenOrgVersion: sql`GREATEST(${userTutorial.seenOrgVersion}, ${values.seenOrgVersion})`,
        outcome: values.outcome,
        step: null,
        updatedAt: now,
      },
    });
  } else if ("step" in body) {
    const step = body.step;
    if (step !== null && (typeof step !== "string" || step.length === 0 || step.length > MAX_STEP_LENGTH)) {
      throw new TutorialInputError(`step must be a step id of 1 to ${MAX_STEP_LENGTH} characters, or null.`);
    }
    if (body.version === undefined || body.orgVersion === undefined) {
      throw new TutorialInputError("Send version and orgVersion with step: the versions of the tour you show.");
    }
    const orgVersion = await orgTutorialVersion(db, user.orgId);
    // A step from a tour loaded before a version bump or an org reset is
    // stale: the new tour must start at its first step.
    if (body.version !== current || body.orgVersion !== orgVersion) return getTutorialState(db, version, user);
    // While a pass is in progress, the seen versions record the tour the
    // step belongs to. A reset that lands after this write raises the org
    // version past it, so the step no longer resumes (getTutorialState).
    await db.insert(userTutorial).values({
      userId: user.id, seenVersion: current, seenOrgVersion: orgVersion, outcome: null, step, updatedAt: now,
    }).onConflictDoUpdate({
      target: userTutorial.userId,
      set: {
        seenVersion: sql`GREATEST(${userTutorial.seenVersion}, ${current})`,
        seenOrgVersion: sql`GREATEST(${userTutorial.seenOrgVersion}, ${orgVersion})`,
        outcome: null, step, updatedAt: now,
      },
      // Only while the tour is due: a progress write that arrives after Done
      // or Skip for the current versions must not reopen the tour.
      setWhere: or(
        isNull(userTutorial.outcome),
        lt(userTutorial.seenVersion, current),
        lt(userTutorial.seenOrgVersion, orgVersion),
      ),
    });
  } else {
    throw new TutorialInputError("Send step, or outcome with the versions you saw.");
  }
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
