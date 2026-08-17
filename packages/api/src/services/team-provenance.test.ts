/**
 * Tests for the boundary between the two team writers: the boot reconciler
 * (`config-reconcile.ts`, driven by `valet.yaml`) and the login sync
 * (`team-sync.ts`, driven by the identity provider's group claim).
 *
 * They live in one file because neither subsystem can prove this alone. The
 * rule under test is that a team's `origin` names exactly one writer of its
 * `team_members` rows, so the two passes hold disjoint row sets and the order
 * they run in cannot change the result.
 *
 * The failure this guards against is a loop, not a crash: one pass adds a
 * member at boot, the other removes it at the next login, and the pair repeat
 * for as long as both sources name the same team.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { orgMembers, teamMembers, teams, users } from "../schema/index.js";
import { InstanceConfigError, type InstanceConfig } from "../config/instance-config.js";
import { ensureOrg } from "./org.js";
import { reconcileInstanceConfig } from "./config-reconcile.js";
import { reconcileIdpTeams } from "./team-sync.js";

const ADMIN_GROUP = "admins";

let db: AppDb;
let orgId: string;

beforeEach(async () => {
  ({ appDb: db } = await freshTestPgDb());
  orgId = (await ensureOrg(db)).id;
});

/** A user who is already an org member, which both passes require. */
async function seedMember(id: string, email: string): Promise<void> {
  await db.insert(users).values({ id, email, name: id, role: "member" });
  await db.insert(orgMembers).values({ orgId, userId: id, role: "member", createdAt: Date.now() });
}

/** One boot: apply the declarative config. */
async function boot(cfg: InstanceConfig): Promise<void> {
  await reconcileInstanceConfig({ db, configPath: "/etc/valet/valet.yaml" }, cfg);
}

/**
 * One single-sign-on login, with the group paths the claim carried.
 *
 * The allowlist covers both groups these tests use. It is explicit because
 * the sync has no "mirror everything" value: a login that named no group
 * would mirror nothing, and every provenance test here would pass without
 * ever creating the `idp` row it is about.
 */
async function signIn(userId: string, paths: string[]) {
  return reconcileIdpTeams(db, {
    orgId,
    userId,
    claim: { present: true, paths },
    adminGroupName: ADMIN_GROUP,
    mirroredGroups: ["/platform", "/research"],
    configPath: "/etc/valet/valet.yaml",
  });
}

/** Every team the user belongs to, with the row's provenance, sorted by name. */
async function membershipsOf(userId: string) {
  return db
    .select({ team: teams.name, origin: teams.origin, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, userId))
    .orderBy(teams.name);
}

describe("a declared team and a group that want the same name", () => {
  const declaresPlatform: InstanceConfig = {
    version: 1,
    teams: [{ name: "platform", members: [{ email: "alice@x.test", role: "admin" }] }],
  };

  it("keeps the declared team and skips the group when the file went first", async () => {
    await seedMember("alice", "alice@x.test");
    await seedMember("bob", "bob@x.test");
    await boot(declaresPlatform);

    // Bob IS in the group. The name is taken by a team the file owns, so the
    // sync mirrors nothing rather than take that team's membership over.
    const result = await signIn("bob", ["/platform"]);

    expect(result.skipped).toEqual([
      { groupPath: "/platform", reason: "name_taken_by_config_team" },
    ]);
    expect(result.createdTeams).toBe(0);
    expect(await membershipsOf("bob")).toEqual([]);

    // The declared team is untouched, and still owned by the file.
    expect(await membershipsOf("alice")).toEqual([
      { team: "platform", origin: "config", role: "admin" },
    ]);
  });

  it("fails boot when the group went first", async () => {
    await seedMember("bob", "bob@x.test");
    await signIn("bob", ["/platform"]);

    // The mirror already holds the name. Adopting it would take a group's
    // membership, so the api refuses to start instead.
    await expect(boot(declaresPlatform)).rejects.toThrow(InstanceConfigError);

    // Bob keeps the team the identity provider gave him.
    expect(await membershipsOf("bob")).toEqual([
      { team: "platform", origin: "idp", role: "member" },
    ]);
  });
});

/**
 * `teams_org_name` compares byte for byte, so the two names below are two
 * rows as far as Postgres is concerned. Both passes have to fold the case
 * themselves, or the org silently ends up holding two teams that every list
 * renders as one and that two different writers each believe they own.
 */
describe("a declared team and a group whose names differ only in case", () => {
  const declaresCapitalised: InstanceConfig = {
    version: 1,
    teams: [{ name: "Platform", members: [{ email: "alice@x.test", role: "admin" }] }],
  };

  it("skips the group when the file went first, instead of creating a second team", async () => {
    await seedMember("alice", "alice@x.test");
    await seedMember("bob", "bob@x.test");
    await boot(declaresCapitalised);

    const result = await signIn("bob", ["/platform"]);

    expect(result.skipped).toEqual([
      { groupPath: "/platform", reason: "name_taken_by_config_team" },
    ]);
    expect(result.createdTeams).toBe(0);

    // One team, not two. This is the assertion that fails without the fold.
    const rows = await db.select({ name: teams.name, origin: teams.origin }).from(teams);
    expect(rows).toEqual([{ name: "Platform", origin: "config" }]);
  });

  it("fails boot when the group went first", async () => {
    await seedMember("bob", "bob@x.test");
    await signIn("bob", ["/platform"]);

    await expect(boot(declaresCapitalised)).rejects.toThrow(InstanceConfigError);
    // The message must name the row's own spelling, or the reader cannot
    // find the team the instruction tells them to rename.
    await expect(boot(declaresCapitalised)).rejects.toThrow(/Team "platform" holds that name/);

    const rows = await db.select({ name: teams.name, origin: teams.origin }).from(teams);
    expect(rows).toEqual([{ name: "platform", origin: "idp" }]);
  });

  it("still fails boot when a local team holds the exact name beside the mirror", async () => {
    // The exact-match path would promote the local row to `config` and leave
    // the mirror in place, so the mirrored-name check has to run first.
    await seedMember("bob", "bob@x.test");
    await signIn("bob", ["/platform"]);
    await db
      .insert(teams)
      .values({ id: "team_local", orgId, name: "Platform", origin: "local", createdAt: Date.now() });

    await expect(boot(declaresCapitalised)).rejects.toThrow(InstanceConfigError);

    const local = await db.select({ origin: teams.origin }).from(teams).where(eq(teams.id, "team_local"));
    expect(local[0]?.origin).toBe("local");
  });
});

describe("a member the file declares and the group omits", () => {
  it("does not flap across two consecutive sign-ins", async () => {
    // Alice is declared in the file. She is NOT in /platform: her claim is
    // present and names no group, which is authoritative — the sync would
    // remove her from any team it owned. It must not own this one.
    await seedMember("alice", "alice@x.test");
    await boot({
      version: 1,
      teams: [{ name: "platform", members: [{ email: "alice@x.test", role: "admin" }] }],
    });

    const afterBoot = await membershipsOf("alice");
    expect(afterBoot).toEqual([{ team: "platform", origin: "config", role: "admin" }]);

    const first = await signIn("alice", []);
    const afterFirst = await membershipsOf("alice");

    const second = await signIn("alice", []);
    const afterSecond = await membershipsOf("alice");

    // Nothing was removed, at either login, and the rows never changed.
    expect(first.removed).toBe(0);
    expect(second.removed).toBe(0);
    expect(afterFirst).toEqual(afterBoot);
    expect(afterSecond).toEqual(afterBoot);
  });

  it("survives a second boot after the sign-ins", async () => {
    // The full cycle the flap would have run: boot, login, boot, login. A
    // membership that oscillates shows up here even if one direction alone
    // looks stable.
    await seedMember("alice", "alice@x.test");
    const cfg: InstanceConfig = {
      version: 1,
      teams: [{ name: "platform", members: [{ email: "alice@x.test", role: "admin" }] }],
    };

    await boot(cfg);
    await signIn("alice", []);
    await boot(cfg);
    await signIn("alice", []);

    expect(await membershipsOf("alice")).toEqual([
      { team: "platform", origin: "config", role: "admin" },
    ]);
  });
});

describe("the sync and the reconciler on separate teams", () => {
  it("each writes its own team and leaves the other's alone", async () => {
    await seedMember("alice", "alice@x.test");
    await boot({
      version: 1,
      teams: [{ name: "platform", members: [{ email: "alice@x.test", role: "admin" }] }],
    });

    // A group with a name nothing else claims. Both teams end up on alice,
    // each owned by the source that made it.
    await signIn("alice", ["/research"]);

    expect(await membershipsOf("alice")).toEqual([
      { team: "platform", origin: "config", role: "admin" },
      { team: "research", origin: "idp", role: "member" },
    ]);

    // Leaving /research revokes only the mirrored team.
    await signIn("alice", []);

    expect(await membershipsOf("alice")).toEqual([
      { team: "platform", origin: "config", role: "admin" },
    ]);
  });
});
