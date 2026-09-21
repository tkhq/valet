import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { VirtualSandboxProvider, type MessageEntry } from "@valet/engine";
import { PgSessionStore, PgEventStream } from "@valet/store-postgres";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { EngineHost } from "../engine/host.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";
import { findFollowedThread, upsertFollowedThread } from "../events/followed-threads.js";
import { linkIdentity } from "./identity-links.js";
import { handleFollowedMessage, slackMessageFields } from "./follow-router.js";

import { eq } from "drizzle-orm";
import { eventSubscriptions, teams, teamMembers, orgMembers } from "../schema/index.js";
import { deliverToAssistantThread } from "../events/assistant-delivery.js";
import { followedMessageActor } from "../events/team-slack-gate.js";

const ORG = "org-1";
const USER = "user-1";

function envelope(event: Record<string, unknown>, eventId = "Ev1"): Record<string, unknown> {
  return { type: "event_callback", event_id: eventId, team_id: "T1", event };
}

describe("slackMessageFields", () => {
  const good = envelope({ type: "message", channel: "C1", thread_ts: "1.2", ts: "1.5", user: "U9", text: "hey" });

  it("parses a threaded human message", () => {
    expect(slackMessageFields(good)).toEqual({
      channel: "C1",
      threadTs: "1.2",
      ts: "1.5",
      user: "U9",
      text: "hey",
      eventId: "Ev1",
    });
  });

  it("drops a top-level message (no thread_ts)", () => {
    expect(slackMessageFields(envelope({ type: "message", channel: "C1", ts: "1.5", text: "x" }))).toBeNull();
  });

  it("drops the bot's own posts and noise subtypes", () => {
    expect(slackMessageFields(envelope({ type: "message", channel: "C1", thread_ts: "1.2", ts: "1.6", bot_id: "B1", text: "x" }))).toBeNull();
    expect(slackMessageFields(envelope({ type: "message", subtype: "message_changed", channel: "C1", thread_ts: "1.2", ts: "1.6", text: "x" }))).toBeNull();
  });

  it("drops non-message events and malformed envelopes", () => {
    expect(slackMessageFields(envelope({ type: "app_mention", channel: "C1", thread_ts: "1.2", ts: "1.6" }))).toBeNull();
    expect(slackMessageFields({ event: { type: "message" } })).toBeNull();
    expect(slackMessageFields(null)).toBeNull();
  });
});

describe("handleFollowedMessage", () => {
  let testDb: TestPgDb;
  let engineHost: EngineHost;
  let faux: FauxProviderRegistration;

  beforeEach(async () => {
    faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    faux.setResponses([fauxAssistantMessage("(noted)")]);
    vi.stubEnv("ANTHROPIC_API_KEY", "faux-key");
    testDb = await freshTestPgDb();
    const { pgdb, appDb } = testDb;
    await appDb.insert(orgMembers).values({ orgId: ORG, userId: USER, role: "member" });
    await linkIdentity(appDb, { provider: "slack", externalId: "U9", userId: USER });
    engineHost = new EngineHost({
      engineStore: new PgSessionStore(pgdb),
      sandboxProvider: new VirtualSandboxProvider(),
      eventStream: new PgEventStream(pgdb),
      engineCredentials: new PgCredentialStore(pgdb, deriveSecretKey("test-key")),
      db: appDb,
      apiBaseUrl: "http://127.0.0.1:1",
      plugins: [],
    });
  });

  afterEach(async () => {
    await engineHost.destroyAll();
    faux.unregister();
    vi.unstubAllEnvs();
  });

  it.each(["removed", "foreign-org", "org-removed"])("denies a team follow with %s membership before fetching context", async (mode) => {
    await testDb.appDb.insert(teams).values({ id: "team-follow", orgId: mode === "foreign-org" ? "other-org" : ORG, name: "Team", createdAt: Date.now() });
    await testDb.appDb.insert(teamMembers).values({ teamId: "team-follow", userId: USER, role: "member" });
    await upsertFollowedThread(testDb.appDb, {
      orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.2",
      ownerType: "team", ownerId: "team-follow", createdBy: USER, lastSeenTs: "1.3",
    });
    if (mode === "removed") await testDb.appDb.delete(teamMembers).where(eq(teamMembers.teamId, "team-follow"));
    if (mode === "org-removed") {
      await testDb.appDb.delete(orgMembers).where(eq(orgMembers.orgId, ORG));
      await testDb.appDb.insert(orgMembers).values({ orgId: "other-org", userId: USER, role: "admin" });
      expect(await testDb.appDb.select().from(teamMembers).where(eq(teamMembers.teamId, "team-follow"))).toHaveLength(1);
    }
    const fetchThreadWindow = vi.fn(async () => null);
    const ensure = vi.spyOn(engineHost, "ensureFreshThread");
    await handleFollowedMessage({ db: testDb.appDb, engineHost, fetchThreadWindow }, {
      orgId: ORG, raw: envelope({ type: "message", channel: "C1", thread_ts: "1.2", ts: "1.7", user: "U9", text: "reply" }),
    });
    expect(fetchThreadWindow).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect((await findFollowedThread(testDb.appDb, { orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.2" }))?.lastSeenTs).toBe("1.3");
  });

  it.each(["personal-nonowner", "foreign-owner", "org-removed"])("rejects %s before routing", async (mode) => {
    await upsertFollowedThread(testDb.appDb, {
      orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.2",
      ownerType: mode === "personal-nonowner" ? "user" : "org",
      ownerId: mode === "personal-nonowner" ? "other-user" : mode === "foreign-owner" ? "other-org" : ORG,
      createdBy: USER, lastSeenTs: "1.3",
    });
    if (mode === "org-removed") await testDb.appDb.delete(orgMembers).where(eq(orgMembers.userId, USER));
    const fetchThreadWindow = vi.fn(async () => null);
    const normalizeChannelMessage = vi.fn(async () => ({ text: "approve" }));
    const ensure = vi.spyOn(engineHost, "ensureFreshThread");
    await handleFollowedMessage({ db: testDb.appDb, engineHost, fetchThreadWindow, normalizeChannelMessage }, {
      orgId: ORG, raw: envelope({ type: "message", channel: "C1", thread_ts: "1.2", ts: "1.7", user: "U9", text: "approve" }),
    });
    expect(fetchThreadWindow).not.toHaveBeenCalled();
    expect(normalizeChannelMessage).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect((await findFollowedThread(testDb.appDb, { orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.2" }))?.lastSeenTs).toBe("1.3");
  });

  it("fails closed for an unknown owner type", async () => {
    expect(await followedMessageActor(testDb.appDb, {
      orgId: ORG, ownerType: "unknown", ownerId: ORG,
    }, "U9")).toBeNull();
  });

  it("allows the personal assistant owner", async () => {
    expect(await followedMessageActor(testDb.appDb, {
      orgId: ORG, ownerType: "user", ownerId: USER,
    }, "U9")).toBe(USER);
  });

  it.each(["missing", "unlinked", "non-member", "removed", "foreign-org"])(
    "does not route a %s sender under the binding actor's authority",
    async (mode) => {
      await testDb.appDb.insert(teams).values({ id: "team-follow", orgId: ORG, name: "Team", createdAt: Date.now() });
      await testDb.appDb.insert(teamMembers).values({ teamId: "team-follow", userId: USER, role: "member" });
      await upsertFollowedThread(testDb.appDb, {
        orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.2",
        ownerType: "team", ownerId: "team-follow", createdBy: USER, lastSeenTs: "1.3",
      });
      if (mode !== "unlinked" && mode !== "missing") {
        await linkIdentity(testDb.appDb, { provider: "slack", externalId: "OTHER", userId: "other-user" });
        await testDb.appDb.insert(orgMembers).values({ orgId: mode === "foreign-org" ? "other-org" : ORG, userId: "other-user", role: "member" });
      }
      if (mode === "removed") {
        await testDb.appDb.insert(teamMembers).values({ teamId: "team-follow", userId: "other-user", role: "member" });
        await testDb.appDb.delete(teamMembers).where(eq(teamMembers.userId, "other-user"));
      }
      const fetchThreadWindow = vi.fn(async () => null);
      const normalizeChannelMessage = vi.fn(async () => ({ text: "approve" }));
      const ensure = vi.spyOn(engineHost, "ensureFreshThread");
      await handleFollowedMessage({ db: testDb.appDb, engineHost, fetchThreadWindow, normalizeChannelMessage }, {
        orgId: ORG, raw: envelope({ type: "message", channel: "C1", thread_ts: "1.2", ts: "1.7", user: mode === "missing" ? undefined : "OTHER", text: "approve" }),
      });
      expect(fetchThreadWindow).not.toHaveBeenCalled();
      expect(normalizeChannelMessage).not.toHaveBeenCalled();
      expect(ensure).not.toHaveBeenCalled();
      expect((await findFollowedThread(testDb.appDb, { orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.2" }))?.lastSeenTs).toBe("1.3");
    },
  );

  /** The mention rule a followed thread was bound from. */
  async function seedMentionRule(audience: "team" | "organization" | null): Promise<void> {
    const now = Date.now();
    await testDb.appDb.insert(eventSubscriptions).values({
      id: "sub-follow", orgId: ORG, ownerType: "team", ownerId: "team-follow",
      name: "Team replies", eventKeys: ["slack.app_mention"], filters: [],
      target: { kind: "orchestrator", orchestrator: "team", teamId: "team-follow" },
      audience, enabled: true, createdBy: USER, createdAt: now, updatedAt: now,
    });
  }

  it("continues a thread bound under the organization audience for a member of no team", async () => {
    await testDb.appDb.insert(teams).values({ id: "team-follow", orgId: ORG, name: "Team", createdAt: Date.now() });
    await testDb.appDb.insert(orgMembers).values({ orgId: ORG, userId: "org-only", role: "member" });
    await linkIdentity(testDb.appDb, { provider: "slack", externalId: "U9", userId: "org-only" });
    await seedMentionRule("organization");
    await upsertFollowedThread(testDb.appDb, {
      orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.2",
      ownerType: "team", ownerId: "team-follow", createdBy: "org-only", subscriptionId: "sub-follow",
    });
    const deps = { db: testDb.appDb, engineHost, botUserId: "UBOT" };
    await handleFollowedMessage(deps, { orgId: ORG, raw: envelope({
      type: "message", channel: "C1", thread_ts: "1.2", ts: "1.7", user: "U9", text: "later thought",
    }) });
    const session = await defaultAssistantSessionFor(deps, { type: "team", id: "team-follow" }, { actorUserId: "org-only", orgId: ORG });
    await vi.waitFor(async () => {
      const entries = await session.providers.store.getEntries(session.id, session.thread("slack:C1:1.2").id);
      expect(entries.find((e) => e.type === "message" && e.role === "user")).toMatchObject({ author: { id: "org-only" } });
    });
  });

  it("drops an organization-audience follow once its actor leaves the organization", async () => {
    await testDb.appDb.insert(teams).values({ id: "team-follow", orgId: ORG, name: "Team", createdAt: Date.now() });
    await seedMentionRule("organization");
    await upsertFollowedThread(testDb.appDb, {
      orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.2",
      ownerType: "team", ownerId: "team-follow", createdBy: "org-only", subscriptionId: "sub-follow",
      lastSeenTs: "1.3",
    });
    const fetchThreadWindow = vi.fn(async () => null);
    const ensure = vi.spyOn(engineHost, "ensureFreshThread");
    await handleFollowedMessage({ db: testDb.appDb, engineHost, fetchThreadWindow }, {
      orgId: ORG, raw: envelope({ type: "message", channel: "C1", thread_ts: "1.2", ts: "1.7", user: "U9", text: "reply" }),
    });
    expect(fetchThreadWindow).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
  });

  it("narrowing the rule to the team narrows a thread it bound under the organization", async () => {
    await testDb.appDb.insert(teams).values({ id: "team-follow", orgId: ORG, name: "Team", createdAt: Date.now() });
    await testDb.appDb.insert(orgMembers).values({ orgId: ORG, userId: "org-only", role: "member" });
    await linkIdentity(testDb.appDb, { provider: "slack", externalId: "U9", userId: "org-only" });
    await seedMentionRule("organization");
    await upsertFollowedThread(testDb.appDb, {
      orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.2",
      ownerType: "team", ownerId: "team-follow", createdBy: "org-only",
      subscriptionId: "sub-follow", lastSeenTs: "1.3",
    });
    // The rule is narrowed back to the team. The thread must narrow with it.
    await testDb.appDb.update(eventSubscriptions).set({ audience: "team" }).where(eq(eventSubscriptions.id, "sub-follow"));
    const fetchThreadWindow = vi.fn(async () => null);
    const ensure = vi.spyOn(engineHost, "ensureFreshThread");
    await handleFollowedMessage({ db: testDb.appDb, engineHost, fetchThreadWindow }, {
      orgId: ORG, raw: envelope({ type: "message", channel: "C1", thread_ts: "1.2", ts: "1.7", user: "U9", text: "reply" }),
    });
    expect(fetchThreadWindow).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
  });

  it("a disabled rule stops the organization audience in the threads it opened", async () => {
    await testDb.appDb.insert(teams).values({ id: "team-follow", orgId: ORG, name: "Team", createdAt: Date.now() });
    await testDb.appDb.insert(orgMembers).values({ orgId: ORG, userId: "org-only", role: "member" });
    await linkIdentity(testDb.appDb, { provider: "slack", externalId: "U9", userId: "org-only" });
    await seedMentionRule("organization");
    await upsertFollowedThread(testDb.appDb, {
      orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.2",
      ownerType: "team", ownerId: "team-follow", createdBy: "org-only",
      subscriptionId: "sub-follow", lastSeenTs: "1.3",
    });
    const deps = { db: testDb.appDb, engineHost, botUserId: "UBOT" };

    await testDb.appDb.update(eventSubscriptions).set({ enabled: false }).where(eq(eventSubscriptions.id, "sub-follow"));
    const fetchThreadWindow = vi.fn(async () => null);
    const ensure = vi.spyOn(engineHost, "ensureFreshThread");
    await handleFollowedMessage({ ...deps, fetchThreadWindow }, {
      orgId: ORG, raw: envelope({ type: "message", channel: "C1", thread_ts: "1.2", ts: "1.7", user: "U9", text: "while off" }, "EvOff"),
    });
    expect(fetchThreadWindow).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();

    await testDb.appDb.update(eventSubscriptions).set({ enabled: true }).where(eq(eventSubscriptions.id, "sub-follow"));
    await handleFollowedMessage(deps, { orgId: ORG, raw: envelope({
      type: "message", channel: "C1", thread_ts: "1.2", ts: "1.8", user: "U9", text: "and back on",
    }, "EvOn") });
    const session = await defaultAssistantSessionFor(deps, { type: "team", id: "team-follow" }, { actorUserId: "org-only", orgId: ORG });
    await vi.waitFor(async () => {
      const entries = await session.providers.store.getEntries(session.id, session.thread("slack:C1:1.2").id);
      expect(entries.find((e) => e.type === "message" && e.role === "user")).toMatchObject({ author: { id: "org-only" } });
    });
  });

  it("a team member's follow keeps working after its binding rule is gone", async () => {
    await testDb.appDb.insert(teams).values({ id: "team-follow", orgId: ORG, name: "Team", createdAt: Date.now() });
    await testDb.appDb.insert(teamMembers).values({ teamId: "team-follow", userId: USER, role: "member" });
    // The rule is deleted; the binder is still a member, so the team keeps
    // the thread. Only the wider audience is lost.
    await upsertFollowedThread(testDb.appDb, {
      orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.2",
      ownerType: "team", ownerId: "team-follow", createdBy: USER, subscriptionId: "sub-gone",
    });
    const deps = { db: testDb.appDb, engineHost, botUserId: "UBOT" };
    await handleFollowedMessage(deps, { orgId: ORG, raw: envelope({
      type: "message", channel: "C1", thread_ts: "1.2", ts: "1.7", user: "U9", text: "still here",
    }) });
    const session = await defaultAssistantSessionFor(deps, { type: "team", id: "team-follow" }, { actorUserId: USER, orgId: ORG });
    await vi.waitFor(async () => {
      const entries = await session.providers.store.getEntries(session.id, session.thread("slack:C1:1.2").id);
      expect(entries.find((e) => e.type === "message" && e.role === "user")).toMatchObject({ author: { id: USER } });
    });
  });

  it("a follow that names no rule stays team-only", async () => {
    await testDb.appDb.insert(teams).values({ id: "team-follow", orgId: ORG, name: "Team", createdAt: Date.now() });
    await testDb.appDb.insert(orgMembers).values({ orgId: ORG, userId: "org-only", role: "member" });
    await linkIdentity(testDb.appDb, { provider: "slack", externalId: "U9", userId: "org-only" });
    // Every follow bound before the rule id existed looks like this. It must
    // read as team-only, never as the wider audience.
    await upsertFollowedThread(testDb.appDb, {
      orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.2",
      ownerType: "team", ownerId: "team-follow", createdBy: "org-only", lastSeenTs: "1.3",
    });
    const fetchThreadWindow = vi.fn(async () => null);
    const ensure = vi.spyOn(engineHost, "ensureFreshThread");
    await handleFollowedMessage({ db: testDb.appDb, engineHost, fetchThreadWindow }, {
      orgId: ORG, raw: envelope({ type: "message", channel: "C1", thread_ts: "1.2", ts: "1.7", user: "U9", text: "reply" }),
    });
    expect(fetchThreadWindow).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
  });

  it("attributes an authorized teammate reply to its actual sender", async () => {
    await testDb.appDb.insert(orgMembers).values({ orgId: ORG, userId: "other-user", role: "member" });
    await linkIdentity(testDb.appDb, { provider: "slack", externalId: "OTHER", userId: "other-user" });
    await testDb.appDb.insert(teams).values({ id: "team-follow", orgId: ORG, name: "Team", createdAt: Date.now() });
    await testDb.appDb.insert(teamMembers).values({ teamId: "team-follow", userId: USER, role: "member" });
    await testDb.appDb.insert(teamMembers).values({ teamId: "team-follow", userId: "other-user", role: "member" });
    await upsertFollowedThread(testDb.appDb, {
      orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.2",
      ownerType: "team", ownerId: "team-follow", createdBy: USER,
    });
    const deps = { db: testDb.appDb, engineHost, botUserId: "UBOT" };
    await handleFollowedMessage(deps, { orgId: ORG, raw: envelope({
      type: "message", channel: "C1", thread_ts: "1.2", ts: "1.7", user: "OTHER", text: "<@OTHERBOT> reply",
    }) });
    const session = await defaultAssistantSessionFor(deps, { type: "team", id: "team-follow" }, { actorUserId: USER, orgId: ORG });
    await vi.waitFor(async () => {
      const entries = await session.providers.store.getEntries(session.id, session.thread("slack:C1:1.2").id);
      expect(entries.find((e) => e.type === "message" && e.role === "user")).toMatchObject({ author: { id: "other-user" }, signal: { origin: { reply: "manual" } } });
    });
  });

  it.each([true, false])("paired Slack envelopes produce one addressed turn (message first=%s)", async (messageFirst) => {
    const deps = { db: testDb.appDb, engineHost, botUserId: "UBOT" };
    await upsertFollowedThread(testDb.appDb, {
      orgId: ORG, channelType: "slack", channelId: "C1", threadTs: "1.2",
      ownerType: "user", ownerId: USER, createdBy: USER,
    });
    const session = await defaultAssistantSessionFor(deps, { type: "user", id: USER }, { actorUserId: USER, orgId: ORG });
    const message = () => handleFollowedMessage(deps, { orgId: ORG, raw: envelope({
      type: "message", channel: "C1", thread_ts: "1.2", ts: "1.7", user: "U9", text: "<@UBOT> help",
    }, "EvMessage") });
    const mention = () => deliverToAssistantThread(deps, {
      orgId: ORG, owner: { type: "user", id: USER }, actorUserId: USER, threadKey: "slack:C1:1.2",
      signal: { kind: "signal", signalType: "slack.app_mention", body: "help", origin: { channelType: "slack", threadKey: "slack:C1:1.2", messageTs: "1.7", reply: "auto" } },
      dispatchId: "event:mention-delivery", mismatchReason: "test",
    });
    if (messageFirst) { await message(); await mention(); }
    else { await mention(); await message(); }
    await message();
    await mention();
    const thread = session.thread("slack:C1:1.2");
    await vi.waitFor(async () => {
      const entries = await session.providers.store.getEntries(session.id, thread.id);
      const prompts = entries.filter((e) => e.type === "message" && e.role === "user");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({ signal: { origin: { reply: "auto" } } });
    });
  });

  it("routes a followed threaded message to the bound assistant thread as an overheard signal", async () => {
    await upsertFollowedThread(testDb.appDb, {
      orgId: ORG,
      channelType: "slack",
      channelId: "C1",
      threadTs: "1.2",
      ownerType: "org",
      ownerId: ORG,
      createdBy: USER,
    });

    await handleFollowedMessage(
      { db: testDb.appDb, engineHost },
      { orgId: ORG, raw: envelope({ type: "message", channel: "C1", thread_ts: "1.2", ts: "1.7", user: "U9", text: "any update?" }) },
    );

    const session = await defaultAssistantSessionFor(
      { db: testDb.appDb, engineHost },
      { type: "org", id: ORG },
      { actorUserId: USER, orgId: ORG },
    );
    const threadId = session.thread("slack:C1:1.2").id;
    let userEntry: MessageEntry | undefined;
    for (let i = 0; i < 100; i++) {
      const entries = await session.providers.store.getEntries(session.id, threadId);
      userEntry = entries.find((e) => e.type === "message" && e.role === "user") as MessageEntry | undefined;
      if (userEntry) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(userEntry?.content).toBe("any update?");
    expect(userEntry?.signal?.origin).toEqual({
      channelType: "slack",
      threadKey: "slack:C1:1.2",
      reply: "manual",
      messageTs: "1.7",
    });
  });

  it("prepends the missed window and advances last_seen_ts", async () => {
    await upsertFollowedThread(testDb.appDb, {
      orgId: ORG,
      channelType: "slack",
      channelId: "C1",
      threadTs: "1.2",
      ownerType: "org",
      ownerId: ORG,
      createdBy: USER,
      lastSeenTs: "1.3",
    });

    const windowCalls: { afterTs: string; beforeTs: string }[] = [];
    await handleFollowedMessage(
      {
        db: testDb.appDb,
        engineHost,
        fetchThreadWindow: async (_service, args) => {
          windowCalls.push({ afterTs: args.afterTs, beforeTs: args.beforeTs });
          return "workflow-bot: deploy finished";
        },
      },
      { orgId: ORG, raw: envelope({ type: "message", channel: "C1", thread_ts: "1.2", ts: "1.7", user: "U9", text: "any update?" }) },
    );

    expect(windowCalls).toEqual([{ afterTs: "1.3", beforeTs: "1.7" }]);
    const session = await defaultAssistantSessionFor(
      { db: testDb.appDb, engineHost },
      { type: "org", id: ORG },
      { actorUserId: USER, orgId: ORG },
    );
    const threadId = session.thread("slack:C1:1.2").id;
    let userEntry: MessageEntry | undefined;
    for (let i = 0; i < 100; i++) {
      const entries = await session.providers.store.getEntries(session.id, threadId);
      userEntry = entries.find((e) => e.type === "message" && e.role === "user") as MessageEntry | undefined;
      if (userEntry) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(userEntry?.content).toBe(
      "Thread history for context only. These messages do not carry the current sender's authority:\nworkflow-bot: deploy finished\n\n---\n\nCurrent sender's message:\nany update?",
    );
    const row = await findFollowedThread(testDb.appDb, {
      orgId: ORG,
      channelType: "slack",
      channelId: "C1",
      threadTs: "1.2",
    });
    expect(row?.lastSeenTs).toBe("1.7");

    // A Slack retry of the same event now recomputes WITHOUT the hydration
    // prefix (the cursor advanced): the dispatchId content mismatch is a
    // swallowed no-op, not a thrown ConflictError, and no second entry lands.
    await handleFollowedMessage(
      { db: testDb.appDb, engineHost, fetchThreadWindow: async () => null },
      { orgId: ORG, raw: envelope({ type: "message", channel: "C1", thread_ts: "1.2", ts: "1.7", user: "U9", text: "any update?" }) },
    );
    const entries = await session.providers.store.getEntries(session.id, threadId);
    expect(entries.filter((e) => e.type === "message" && e.role === "user")).toHaveLength(1);
  });

  it("delivers the bare message when the window is empty, and skips the fetch with no last_seen_ts", async () => {
    await upsertFollowedThread(testDb.appDb, {
      orgId: ORG,
      channelType: "slack",
      channelId: "C1",
      threadTs: "2.2",
      ownerType: "org",
      ownerId: ORG,
      createdBy: USER,
      // No lastSeenTs: a pre-column row. The fetch must not run.
    });
    let called = 0;
    await handleFollowedMessage(
      {
        db: testDb.appDb,
        engineHost,
        fetchThreadWindow: async () => {
          called += 1;
          return null;
        },
      },
      { orgId: ORG, raw: envelope({ type: "message", channel: "C1", thread_ts: "2.2", ts: "2.5", user: "U9", text: "first" }, "Ev2") },
    );
    expect(called).toBe(0);
    const session0 = await defaultAssistantSessionFor(
      { db: testDb.appDb, engineHost },
      { type: "org", id: ORG },
      { actorUserId: USER, orgId: ORG },
    );
    // Wait for the first delivery's entry before the second, so the two
    // overheard signals cannot coalesce into a digest (TKAI-297) and each
    // writes its own user entry.
    const threadId0 = session0.thread("slack:C1:2.2").id;
    for (let i = 0; i < 100; i++) {
      const entries = await session0.providers.store.getEntries(session0.id, threadId0);
      if (entries.some((e) => e.type === "message" && e.role === "user")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    // Tracking starts at this delivery; the next gap fetch runs but an empty
    // window (null) delivers the bare message.
    await handleFollowedMessage(
      {
        db: testDb.appDb,
        engineHost,
        fetchThreadWindow: async () => {
          called += 1;
          return null;
        },
      },
      { orgId: ORG, raw: envelope({ type: "message", channel: "C1", thread_ts: "2.2", ts: "2.9", user: "U9", text: "second" }, "Ev3") },
    );
    expect(called).toBe(1);
    const session = await defaultAssistantSessionFor(
      { db: testDb.appDb, engineHost },
      { type: "org", id: ORG },
      { actorUserId: USER, orgId: ORG },
    );
    const threadId = session.thread("slack:C1:2.2").id;
    let entries: Awaited<ReturnType<typeof session.providers.store.getEntries>> = [];
    for (let i = 0; i < 100; i++) {
      entries = await session.providers.store.getEntries(session.id, threadId);
      if (entries.filter((e) => e.type === "message" && e.role === "user").length >= 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const bodies = entries
      .filter((e): e is MessageEntry => e.type === "message" && e.role === "user")
      .map((e) => e.content);
    expect(bodies).toContain("second");
    expect(bodies.some((b) => typeof b === "string" && b.includes("since you last saw it"))).toBe(false);
  });

  it("ignores a message on an unfollowed thread (no delivery)", async () => {
    await handleFollowedMessage(
      { db: testDb.appDb, engineHost },
      { orgId: ORG, raw: envelope({ type: "message", channel: "C1", thread_ts: "9.9", ts: "9.9", user: "U9", text: "hi" }) },
    );
    const session = await defaultAssistantSessionFor(
      { db: testDb.appDb, engineHost },
      { type: "org", id: ORG },
      { actorUserId: USER, orgId: ORG },
    );
    const entries = await session.providers.store.getEntries(session.id, session.thread("slack:C1:9.9").id);
    expect(entries.filter((e) => e.type === "message" && e.role === "user")).toHaveLength(0);
  });
});
