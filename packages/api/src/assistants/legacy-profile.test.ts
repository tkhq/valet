/**
 * A workspace whose assistant was customized before the workspace runtime
 * keeps its name, avatar, and personality. The columns exist only on a
 * database upgraded from before that change, so each test that needs them
 * adds them the way the old schema had them.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Principal } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { orgs, teams } from "../schema/index.js";
import { workspaceSenderIdentity } from "../services/workspace-sender.js";
import { loadLegacyAssistantProfile } from "./legacy-profile.js";
import { resolveDefaultAssistant } from "./service.js";

const ORG = "org1";
const TEAM: Principal = { type: "team", id: "team_1" };
const USER: Principal = { type: "user", id: "user_1" };
const AVATAR = "https://valet.example/avatars/assistants/abc.webp";

/** The pre-workspace-runtime columns, as an upgraded database still has them. */
async function addLegacyColumns(db: AppDb): Promise<void> {
  await db.execute(sql`ALTER TABLE assistants ADD COLUMN IF NOT EXISTS name text,
    ADD COLUMN IF NOT EXISTS avatar_url text, ADD COLUMN IF NOT EXISTS personality text`);
}

async function setLegacy(db: AppDb, owner: Principal, name: string | null, avatar: string | null, personality: string | null) {
  await db.execute(sql`UPDATE assistants SET name = ${name}, avatar_url = ${avatar}, personality = ${personality}
    WHERE org_id = ${ORG} AND owner_type = ${owner.type} AND owner_id = ${owner.id}`);
}

describe("carried-over assistant profile", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: ORG, name: "Org", createdAt: Date.now() });
    await db.insert(teams).values({ id: TEAM.id, orgId: ORG, name: "platform", createdAt: Date.now() });
    await resolveDefaultAssistant(db, ORG, TEAM);
    await resolveDefaultAssistant(db, ORG, USER);
  });

  it("reads nothing, and does not fail, on a database without the old columns", async () => {
    expect(await loadLegacyAssistantProfile(db, ORG, TEAM)).toBeUndefined();
    expect(await workspaceSenderIdentity(db, ORG, TEAM)).toEqual({ displayName: "platform" });
    expect(await workspaceSenderIdentity(db, ORG, USER)).toBeUndefined();
  });

  it("posts as the customized name and avatar in place of the team name", async () => {
    await addLegacyColumns(db);
    await setLegacy(db, TEAM, "Desk Helper", AVATAR, "Warm and brief.");
    expect(await loadLegacyAssistantProfile(db, ORG, TEAM)).toEqual({ name: "Desk Helper", avatarUrl: AVATAR, personality: "Warm and brief.", upgradedAt: expect.any(Number) });
    expect(await workspaceSenderIdentity(db, ORG, TEAM)).toEqual({ displayName: "Desk Helper", avatarUrl: AVATAR });
  });

  it("gives a customized personal assistant its name, where the bot identity was the default", async () => {
    await addLegacyColumns(db);
    await setLegacy(db, USER, "Home Helper", null, null);
    expect(await workspaceSenderIdentity(db, ORG, USER)).toEqual({ displayName: "Home Helper" });
  });

  it("keeps the team name when the old profile set none, and ignores blank values", async () => {
    await addLegacyColumns(db);
    await setLegacy(db, TEAM, "  ", null, null);
    expect(await loadLegacyAssistantProfile(db, ORG, TEAM)).toBeUndefined();
    expect(await workspaceSenderIdentity(db, ORG, TEAM)).toEqual({ displayName: "platform" });
  });

  it("reads only the workspace's live assistant, not a retired one", async () => {
    await addLegacyColumns(db);
    await db.execute(sql`UPDATE assistants SET name = 'Retired', archived_at = 1
      WHERE org_id = ${ORG} AND owner_type = ${TEAM.type} AND owner_id = ${TEAM.id}`);
    expect(await loadLegacyAssistantProfile(db, ORG, TEAM)).toBeUndefined();
  });
});
