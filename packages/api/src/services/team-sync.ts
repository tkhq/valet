/**
 * Team sync — mirrors an identity provider's groups into Valet teams, once
 * per single-sign-on login.
 *
 * ## The model
 *
 * The identity provider owns the teams it names, and nothing else. A team
 * row with `origin='idp'` mirrors one group, and this file is the only
 * writer of those rows and of their memberships. A team somebody made in
 * Valet (`origin='local'`) is a different kind of thing: the sync never
 * renames one, never deletes one, and never takes over its membership.
 * Every write and every delete below is scoped by `origin='idp'`, the same
 * way `skill-sync.ts` scopes its writes by `origin='repo'`.
 *
 * ## A missing claim is not an empty claim
 *
 * Membership arrives in a token claim. That claim can be missing for
 * reasons that say nothing about the user: a mapper nobody configured, a
 * scope nobody requested, a provider that sends no groups at all. Absent
 * therefore means NO INFORMATION, and the sync writes nothing. Only a claim
 * that is explicitly present may remove somebody from a team — an empty
 * array is present, and it is authoritative. A claim the sync cannot read
 * counts as absent, because a half-read list removes the half it lost.
 *
 * Read the other way, one mapper edit deprovisions every user of the
 * deployment on their next login. This repo shipped that failure once
 * already, in the skill sync, where a truncated directory listing read as
 * "everything was deleted upstream" (`skill-sync.ts`, "A transport failure
 * is different").
 *
 * Keycloak drops the group claim for a user who is in no groups (measured
 * on 26.2), so "in no groups" and "no mapper" arrive identical. A second
 * mapper closes the gap: a hardcoded marker claim that is always sent. The
 * marker present and the group claim absent means "this user is in no
 * groups", and only then may the sync empty their teams.
 *
 * ## Admin comes from a sub-group
 *
 * `/platform` makes you a member of team `platform`. `/platform/admins`
 * additionally makes you its admin. Keycloak does not report the parent
 * group for a sub-group member, so parent membership is derived from the
 * path. Nothing else is derived: a deeper path, and any other sub-group,
 * are ignored. To invent a membership is as dangerous as to revoke one.
 *
 * The path is the only evidence there is, and it can lie. Keycloak accepts a
 * group name that contains `/`, so a TOP-LEVEL group named `platform/admins`
 * reports the path `/platform/admins` — the same path as the `admins`
 * sub-group of `platform` (measured on 26.2). A member of the flat group
 * therefore becomes an admin of team `platform`. The two claims are
 * identical, so no rule here can separate them. The identity provider must
 * keep `/` out of group names; `docs/environment-variables.md` says so.
 *
 * ## Direct writes, on purpose
 *
 * The sync writes `team_members` itself. It never calls `addMember`,
 * `setRole` or `removeMember`, because those refuse to remove or demote a
 * team's last admin — which is the exact write that offboarding needs. When
 * the identity provider empties `/platform/admins`, the last admin must
 * lose the role. Those guards protect a team people manage by hand. This
 * file mirrors a group that nobody manages by hand.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { isPgUniqueViolation } from "@valet/store-postgres";
import type { AppDb } from "../lib/drizzle.js";
import { teamMembers, teams } from "../schema/index.js";
import type { TeamRole } from "./teams.js";

/**
 * What the token said about this user's groups.
 *
 * `present: false` is the whole safety property of this file: the claim was
 * missing, so the sync knows nothing and changes nothing. `present: true`
 * with an empty `paths` is the opposite — the identity provider stated that
 * this user is in no groups, and the sync acts on it.
 */
export type TeamClaim = { present: false } | { present: true; paths: string[] };

/** One team the claim asks for, after the paths are resolved. */
export interface DesiredTeam {
  /** Full group path of the parent group, e.g. `/platform`. */
  path: string;
  /** Team name — the last segment of the path. */
  name: string;
  role: TeamRole;
}

export interface DesiredTeams {
  /** Keyed by group path, so a repeated path merges instead of duplicating. */
  teams: Map<string, DesiredTeam>;
  /** Paths Valet does not mirror. Reported, never guessed at. */
  ignored: string[];
}

/** Why one group produced no team and no membership. */
export type SkipReason =
  | "path_not_mirrored"
  | "name_taken_by_local_team"
  | "name_taken_by_other_group"
  | "team_unavailable";

export interface SkippedGroup {
  groupPath: string;
  reason: SkipReason;
}

export interface ReconcileResult {
  /**
   * False when the claim was absent. Nothing was read and nothing was
   * written, so every counter below is zero.
   */
  applied: boolean;
  /** Teams created to mirror a group Valet had not seen before. */
  createdTeams: number;
  added: number;
  roleChanged: number;
  removed: number;
  skipped: SkippedGroup[];
}

export interface ReconcileOptions {
  orgId: string;
  userId: string;
  claim: TeamClaim;
  /** Sub-group name that grants admin on the parent team, e.g. `admins`. */
  adminGroupName: string;
}

const NOTHING: ReconcileResult = {
  applied: false,
  createdTeams: 0,
  added: 0,
  roleChanged: 0,
  removed: 0,
  skipped: [],
};

function newTeamId(): string {
  return `team_${randomUUID()}`;
}

/**
 * Reads the group claim out of the provider's user info.
 *
 * An array of strings is authoritative, empty or not. Absent falls through
 * to the marker claim, and only a present marker turns absence into "no
 * groups". Anything else — a bare string, a number, an object — is a mapper
 * that sends one value instead of a list. That is a misconfiguration, and
 * the sync must not guess what it meant, so it reports "no information" and
 * changes nothing.
 *
 * An entry that is not a string gets the same answer, and for a sharper
 * reason. A provider that sends `[{ "name": "/platform" }]` names groups
 * this function cannot read. To drop those entries would leave a SHORTER
 * list that still looks authoritative, and the reconcile would remove every
 * team the dropped entries named. One unreadable entry therefore makes the
 * whole claim unreadable. A blank string is different: it names no group, so
 * nothing is lost when it goes — unless the blanks are all there is. A list
 * that arrived with entries and names no group is junk from the mapper, and
 * an empty result would look exactly like "in no groups". That list gets the
 * same answer as an unreadable one.
 */
export function readTeamClaim(
  userInfo: Record<string, unknown>,
  claimName: string,
  assertedClaimName: string,
): TeamClaim {
  const raw = userInfo[claimName];

  if (Array.isArray(raw)) {
    const entries: unknown[] = raw;
    const strings = entries.filter((entry): entry is string => typeof entry === "string");
    if (strings.length !== entries.length) {
      console.warn(
        `team sync: claim '${claimName}' holds entries that are not group paths, so team membership ` +
          `was not changed. Configure the identity provider mapper to send each group as a full path ` +
          `string, such as '/platform'.`,
      );
      return { present: false };
    }
    const paths = strings.filter((path) => path.trim().length > 0);
    if (entries.length > 0 && paths.length === 0) {
      console.warn(
        `team sync: claim '${claimName}' names no group, so team membership was not changed. ` +
          `Configure the identity provider mapper to send each group as a full path string, ` +
          `such as '/platform'.`,
      );
      return { present: false };
    }
    return { present: true, paths };
  }

  if (raw === undefined || raw === null) {
    // Read the marker as an OWN property. A plain lookup also finds the keys
    // every object inherits — `constructor`, `toString`, `valueOf` — so a
    // marker claim named after one of them would read as present for every
    // user, and the absent group claim would then empty everybody's teams.
    // The marker is the one input that authorises a removal, so it must
    // prove that the provider sent it, not that JavaScript supplies it.
    const marker = Object.hasOwn(userInfo, assertedClaimName)
      ? userInfo[assertedClaimName]
      : undefined;
    // The marker proves the mapper set ran, so the missing group claim means
    // this user is in no groups. Without it, absence stays unreadable.
    if (marker !== undefined && marker !== null) return { present: true, paths: [] };
    return { present: false };
  }

  console.warn(
    `team sync: claim '${claimName}' is not a list, so team membership was not changed. ` +
      `Configure the identity provider mapper to send a multivalued group claim.`,
  );
  return { present: false };
}

/**
 * Turns group paths into the teams they ask for.
 *
 * Admin always wins the merge, so the order of the claim cannot change the
 * result: `["/platform", "/platform/admins"]` and its reverse both give
 * admin on `platform`.
 */
export function desiredTeamsFromPaths(paths: string[], adminGroupName: string): DesiredTeams {
  const wanted = new Map<string, DesiredTeam>();
  const ignored: string[] = [];

  for (const raw of paths) {
    const segments = raw.trim().split("/").filter((segment) => segment.length > 0);
    const parent = segments[0];
    const isParent = segments.length === 1;
    const isAdminSubGroup = segments.length === 2 && segments[1] === adminGroupName;

    if (parent === undefined || !(isParent || isAdminSubGroup)) {
      ignored.push(raw);
      continue;
    }

    const path = `/${parent}`;
    const current = wanted.get(path);
    const role: TeamRole = isAdminSubGroup ? "admin" : (current?.role ?? "member");
    wanted.set(path, { path, name: parent, role });
  }

  return { teams: wanted, ignored };
}

type ResolveOutcome = { ok: true; teamId: string; created: boolean } | { ok: false; reason: SkipReason };

/**
 * Finds the mirror for one group path.
 *
 * `origin = 'idp'` is part of the search, not a formality. A local team
 * carries no `external_id` today, so the filter changes no result now. It
 * decides what happens the day something else writes that column: without it
 * the sync would ADOPT the local row, and the next claim that omits the group
 * would empty a team the sync never made. With it, the same row reaches the
 * name check instead and the group is skipped, which is the answer a
 * collision must always get.
 */
async function findByExternalId(
  db: AppDb,
  orgId: string,
  path: string,
): Promise<{ id: string } | undefined> {
  const rows = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.orgId, orgId), eq(teams.origin, "idp"), eq(teams.externalId, path)))
    .limit(1);
  return rows[0];
}

async function findByName(
  db: AppDb,
  orgId: string,
  name: string,
): Promise<{ id: string; origin: "local" | "idp"; externalId: string | null } | undefined> {
  const rows = await db
    .select({ id: teams.id, origin: teams.origin, externalId: teams.externalId })
    .from(teams)
    .where(and(eq(teams.orgId, orgId), eq(teams.name, name)))
    .limit(1);
  return rows[0];
}

/**
 * The name is taken, so this group gets no team. The team that holds the
 * name is left exactly as it is.
 *
 * Adoption is the tempting alternative and it is the dangerous one: it
 * would hand an existing team's membership to the identity provider, which
 * then removes everybody the provider does not list. A name coincidence
 * must not cost people their team. A rename is no better — it invents a
 * name that is no longer the group's, and the collision returns the moment
 * anybody renames anything.
 */
function reportCollision(
  existing: { origin: "local" | "idp"; externalId: string | null },
  want: DesiredTeam,
): SkipReason {
  if (existing.origin === "local") {
    console.warn(
      `team sync: group '${want.path}' was skipped. A team named '${want.name}' already exists in this ` +
        `organization, and somebody created it in Valet. Rename or delete that team, then sign in again.`,
    );
    return "name_taken_by_local_team";
  }
  console.warn(
    `team sync: group '${want.path}' was skipped. Team '${want.name}' already mirrors group ` +
      `'${existing.externalId ?? "unknown"}'. Rename one of the two groups in the identity provider, ` +
      `then sign in again.`,
  );
  return "name_taken_by_other_group";
}

/**
 * Finds or creates the team that mirrors one group. Isolated on purpose:
 * one group that cannot be resolved must not cost the user their other
 * teams, so every failure here becomes a skip and the sync continues.
 */
async function resolveIdpTeam(db: AppDb, orgId: string, want: DesiredTeam): Promise<ResolveOutcome> {
  try {
    const mirror = await findByExternalId(db, orgId, want.path);
    if (mirror) return { ok: true, teamId: mirror.id, created: false };

    const holder = await findByName(db, orgId, want.name);
    if (holder) return { ok: false, reason: reportCollision(holder, want) };

    const id = newTeamId();
    // Not `createTeam`: that admits the creator as admin, so the first
    // person through the door would hold admin on every mirrored team
    // regardless of what the identity provider says. A mirror starts empty
    // and the diff below fills it.
    await db.insert(teams).values({
      id,
      orgId,
      name: want.name,
      origin: "idp",
      externalId: want.path,
      createdAt: Date.now(),
    });
    return { ok: true, teamId: id, created: true };
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      // Two people can sign in at the same moment. If the other login won
      // the race on `teams_org_external`, its row is the mirror. If not,
      // `teams_org_name` fired and the name is taken.
      const mirror = await findByExternalId(db, orgId, want.path);
      if (mirror) return { ok: true, teamId: mirror.id, created: false };
      const holder = await findByName(db, orgId, want.name);
      if (holder) return { ok: false, reason: reportCollision(holder, want) };
    }
    console.warn(
      `team sync: group '${want.path}' was skipped because its team could not be read or created. ` +
        `Check the database, then sign in again.`,
      err,
    );
    return { ok: false, reason: "team_unavailable" };
  }
}

/**
 * Reconciles one user's mirrored team membership to match the claim.
 *
 * Removals come from the claim, never from what this run managed to
 * create. A group that failed to resolve is still in the claim, so it
 * produces no removal — a create failure can never deprovision anybody.
 */
export async function reconcileIdpTeams(db: AppDb, opts: ReconcileOptions): Promise<ReconcileResult> {
  // The claim is missing. We hold no information about this user's groups,
  // and information we do not have cannot authorise a write.
  if (!opts.claim.present) return { ...NOTHING, skipped: [] };

  const { teams: wanted, ignored } = desiredTeamsFromPaths(opts.claim.paths, opts.adminGroupName);
  const skipped: SkippedGroup[] = [];

  for (const path of ignored) {
    console.warn(
      `team sync: group path '${path}' was ignored. Valet mirrors a top-level group and its ` +
        `'${opts.adminGroupName}' sub-group only. Move the people into a group like '/platform' or ` +
        `'/platform/${opts.adminGroupName}'.`,
    );
    skipped.push({ groupPath: path, reason: "path_not_mirrored" });
  }

  const roleByTeamId = new Map<string, TeamRole>();
  let createdTeams = 0;

  for (const want of wanted.values()) {
    const outcome = await resolveIdpTeam(db, opts.orgId, want);
    if (!outcome.ok) {
      skipped.push({ groupPath: want.path, reason: outcome.reason });
      continue;
    }
    if (outcome.created) createdTeams += 1;
    roleByTeamId.set(outcome.teamId, want.role);
  }

  // `origin = 'idp'` is what protects user data here. A local team can
  // never enter the removal set. This is a scoping predicate on the rows
  // the sync owns, not an authorisation check — authorisation stays in the
  // routes.
  const current = await db
    .select({ teamId: teamMembers.teamId, role: teamMembers.role, externalId: teams.externalId })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(
      and(eq(teamMembers.userId, opts.userId), eq(teams.orgId, opts.orgId), eq(teams.origin, "idp")),
    );

  const held = new Set<string>();
  const removals: string[] = [];
  const roleChanges: Array<{ teamId: string; role: TeamRole }> = [];

  for (const row of current) {
    // The sync stamps `external_id` on every mirror it creates, so a NULL
    // here belongs to a row the sync did not write. Leave it alone.
    if (row.externalId === null) continue;
    held.add(row.teamId);

    if (!wanted.has(row.externalId)) {
      removals.push(row.teamId);
      continue;
    }
    // A group the claim asks for whose team could not be resolved this run
    // has no desired role. Keep the role that is already there.
    const role = roleByTeamId.get(row.teamId);
    if (role !== undefined && role !== row.role) roleChanges.push({ teamId: row.teamId, role });
  }

  const additions = [...roleByTeamId.entries()]
    .filter(([teamId]) => !held.has(teamId))
    .map(([teamId, role]) => ({ teamId, role }));

  await db.transaction(async (tx) => {
    for (const teamId of removals) {
      await tx
        .delete(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, opts.userId)));
    }
    for (const change of roleChanges) {
      await tx
        .update(teamMembers)
        .set({ role: change.role })
        .where(and(eq(teamMembers.teamId, change.teamId), eq(teamMembers.userId, opts.userId)));
    }
    for (const addition of additions) {
      // Upsert, because the same user can have two logins in flight. The
      // loser of that race must land on the role the claim asked for, not
      // on a duplicate-key failure that aborts the whole reconcile.
      await tx
        .insert(teamMembers)
        .values({ teamId: addition.teamId, userId: opts.userId, role: addition.role })
        .onConflictDoUpdate({
          target: [teamMembers.teamId, teamMembers.userId],
          set: { role: addition.role },
        });
    }
  });

  return {
    applied: true,
    createdTeams,
    added: additions.length,
    roleChanged: roleChanges.length,
    removed: removals.length,
    skipped,
  };
}
