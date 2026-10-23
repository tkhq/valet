import { describe, expect, it, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { agentSessions, assistants, legacyAssistantConversations, legacyAssistantRuntimes, orgs, teams, users } from "../schema/index.js";
import { ArchivedAssistantError, ensureAssistantExecution, ensureDefaultAssistantSession, findDefaultAssistant, resolveDefaultAssistant } from "./service.js";
import { bootTestApi } from "../integration/_setup.js";

const ORG = "org1";
const TEAM = { type: "team", id: "team_1" } as const;

it("does not reuse a legacy shared runtime for an explicitly isolated personal execution", async () => {
  const api = await bootTestApi();
  try {
    const owner = { type: "user", id: "local-user" } as const;
    const meta = { orgId: "local-org", actorUserId: owner.id };
    const root = await ensureDefaultAssistantSession(api.providers, owner, meta);
    const key = "web:legacy-fork";
    const thread = await root.session.createThread(key);
    await api.providers.db.insert(legacyAssistantRuntimes).values({ sessionId: root.sessionId, assistantId: root.assistant.id, orgId: meta.orgId, ownerType: owner.type, ownerId: owner.id });
    await api.providers.db.insert(legacyAssistantConversations).values({ sessionId: root.sessionId, conversationKey: key, threadId: thread.id });
    const isolated = await ensureAssistantExecution(api.providers, owner, meta, key, { isolated: true });
    expect(isolated.sessionId).not.toBe(root.sessionId);
    expect(isolated.session.options.workspace).not.toBe(root.session.options.workspace);
  } finally {
    await api.cleanup();
  }
});

it("stamps a personal execution with its owner when another actor wakes it", async () => {
  const api = await bootTestApi();
  try {
    const owner = { type: "user", id: "local-user" } as const;
    const meta = { orgId: "local-org", actorUserId: "test-member" };
    const root = await ensureDefaultAssistantSession(api.providers, owner, meta);
    const execution = await ensureAssistantExecution(api.providers, owner, meta, "web:owned-fork", { isolated: true });
    expect(execution.sessionId).not.toBe(root.sessionId);
    const rows = await api.providers.db.select().from(agentSessions);
    for (const sessionId of [root.sessionId, execution.sessionId]) {
      expect(rows.find(row => row.id === sessionId)).toMatchObject({ userId: owner.id, ownerType: "user", ownerId: owner.id });
    }
    expect(execution.session.options.userId).toBe(owner.id);
    expect(execution.session.options.owner).toEqual(owner);
  } finally {
    await api.cleanup();
  }
});

describe("resolveDefaultAssistant", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: ORG, name: "Org", createdAt: Date.now() });
  });

  it("seeds inside the caller's transaction and rolls back with it", async () => {
    // `createTeam` seeds the team's default through this function, inside
    // its own transaction, so a failed team insert takes the seed with it.
    await expect(
      db.transaction(async (tx) => {
        const seeded = await resolveDefaultAssistant(tx, ORG, TEAM);
        expect(seeded.ownerId).toBe(TEAM.id);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");

    expect(await findDefaultAssistant(db, ORG, TEAM)).toBeUndefined();
    const rows = await db
      .select()
      .from(assistants)
      .where(and(eq(assistants.ownerType, TEAM.type), eq(assistants.ownerId, TEAM.id)));
    expect(rows).toHaveLength(0);
  });

  it("returns the existing default instead of minting a second one", async () => {
    const first = await resolveDefaultAssistant(db, ORG, TEAM);
    const second = await db.transaction((tx) => resolveDefaultAssistant(tx, ORG, TEAM));
    expect(second.id).toBe(first.id);
  });
  it("converges concurrent initialization to one durable row", async () => {
    const rows = await Promise.all(Array.from({ length: 8 }, () => resolveDefaultAssistant(db, ORG, TEAM)));
    expect(new Set(rows.map(row => row.id)).size).toBe(1);
    expect(await db.select().from(assistants)).toHaveLength(1);
  });

  it("does not replace an archived singleton or free its unique owner slot", async () => {
    const first = await resolveDefaultAssistant(db, ORG, TEAM);
    await db.update(assistants).set({ archivedAt: Date.now() }).where(eq(assistants.id, first.id));
    await expect(resolveDefaultAssistant(db, ORG, TEAM)).rejects.toBeInstanceOf(ArchivedAssistantError);
    const existing = await findDefaultAssistant(db, ORG, TEAM);
    expect(existing?.id).toBe(first.id);
    expect(existing?.archivedAt).not.toBeNull();
    await expect(db.insert(assistants).values({ id: "duplicate", orgId: ORG, ownerType: TEAM.type, ownerId: TEAM.id, sessionId: "assistant:duplicate", createdAt: Date.now() })).rejects.toThrow();
  });

  it("replaces the default for a live team without reviving the old identity", async () => {
    await db.insert(teams).values({ id: TEAM.id, orgId: ORG, name: "Team", createdAt: Date.now() });
    const first = await resolveDefaultAssistant(db, ORG, TEAM);
    await db.update(assistants).set({ archivedAt: Date.now() }).where(eq(assistants.id, first.id));
    expect((await resolveDefaultAssistant(db, ORG, TEAM)).id).not.toBe(first.id);
    const [old] = await db.select().from(assistants).where(eq(assistants.id, first.id));
    expect(old.archivedAt).not.toBeNull();
  });

  it("replaces the default for a live user without reviving the old identity", async () => {
    const user = { type: "user", id: "user_1" } as const;
    await db.insert(users).values({ id: user.id, name: "User", email: "user_1@example.test" });
    const first = await resolveDefaultAssistant(db, ORG, user);
    await db.update(assistants).set({ archivedAt: Date.now() }).where(eq(assistants.id, first.id));
    expect((await resolveDefaultAssistant(db, ORG, user)).id).not.toBe(first.id);
    const [old] = await db.select().from(assistants).where(eq(assistants.id, first.id));
    expect(old.archivedAt).not.toBeNull();
  });

});
