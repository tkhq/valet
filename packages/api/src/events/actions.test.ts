import { eq } from "drizzle-orm";
import githubPlugin from "@valet/plugin-github/plugin";
import { beforeEach, describe, expect, it } from "vitest";
import type { PluginActionContext } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { eventDropLog, eventReceipts, eventSubscriptions, orgMembers, orgs, users, teams, teamMembers } from "../schema/index.js";
import { eventsActionPlugin } from "./actions.js";

const ORG = "event-problems-org";

function context(userId: string, overrides: Partial<PluginActionContext> = {}): PluginActionContext {
  return { userId, orgId: ORG, actionId: "events.list_problems", service: "events", ...overrides } as PluginActionContext;
}

function resultProblems(result: { data?: unknown }): Array<Record<string, unknown>> {
  if (!result.data || typeof result.data !== "object" || !("problems" in result.data)) return [];
  const problems = result.data.problems;
  return Array.isArray(problems) ? problems.filter((problem): problem is Record<string, unknown> => typeof problem === "object" && problem !== null) : [];
}

describe("eventsActionPlugin", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: ORG, name: "Event problems", createdAt: Date.now() });
    await db.insert(users).values([
      { id: "admin", email: "admin@example.test", name: "Admin", role: "admin" },
      { id: "member", email: "member@example.test", name: "Member", role: "member" },
    ]);
    await db.insert(orgMembers).values([
      { orgId: ORG, userId: "admin", role: "admin" },
      { orgId: ORG, userId: "member", role: "member" },
    ]);
  });

  it("lists only the current workspace with bounded pages and exact name matching", async () => {
    const now = Date.now();
    await db.insert(eventSubscriptions).values([
      { id: "a", orgId: ORG, ownerType: "user", ownerId: "member", name: "Match", eventKeys: [], filters: [], target: { kind: "assistant" }, createdBy: "member", createdAt: now, updatedAt: now },
      { id: "b", orgId: ORG, ownerType: "user", ownerId: "member", name: "Other", eventKeys: [], filters: [], target: { kind: "assistant" }, createdBy: "member", createdAt: now, updatedAt: now },
      { id: "c", orgId: ORG, ownerType: "user", ownerId: "admin", name: "Match", eventKeys: [], filters: [], target: { kind: "assistant" }, createdBy: "admin", createdAt: now, updatedAt: now },
      { id: "d", orgId: "foreign", ownerType: "user", ownerId: "member", name: "Match", eventKeys: [], filters: [], target: { kind: "assistant" }, createdBy: "member", createdAt: now, updatedAt: now },
    ]);
    const tool = eventsActionPlugin(db).actions.find(a => a.id === "events.list_subscriptions")!;
    expect(await tool.execute({ limit: 1 }, context("member"))).toMatchObject({ success: true, data: { subscriptions: [{ id: "a" }], nextOffset: 1 } });
    expect(await tool.execute({ limit: 1, offset: 1 }, context("member"))).toMatchObject({ data: { subscriptions: [{ id: "b" }], nextOffset: null } });
    expect(await tool.execute({ name: "Match" }, context("member"))).toMatchObject({ data: { subscriptions: [{ id: "a" }], nextOffset: null } });
    expect(await tool.execute({ limit: 101 }, context("member"))).toMatchObject({ success: false });
    expect(await tool.execute({}, context("member", { externalSender: true }))).toMatchObject({ success: false });
    expect(await tool.execute({}, context("member", { owner: { type: "user", id: "admin" } }))).toMatchObject({ success: false });
  });

  it("sets and clears only the appearance while preserving target fields and refusing other tenants or owners", async () => {
    const now = Date.now();
    const target = { kind: "workflow", workflowId: "wf", deliveryPolicy: "always", futureField: "preserve" };
    // The row stores the old `presence` name; the tool replaces it with `appearance`.
    await db.insert(eventSubscriptions).values({ id: "edit", orgId: ORG, ownerType: "user", ownerId: "member", name: "Rule", eventKeys: ["github.pull_request.opened"], filters: [], target: { ...target, presence: { displayName: "Old" } }, enabled: false, createdBy: "member", createdAt: now, updatedAt: now });
    await db.insert(orgs).values({ id: "foreign", name: "Foreign", createdAt: now });
    await db.insert(orgMembers).values({ orgId: "foreign", userId: "member", role: "member" });
    const tool = eventsActionPlugin(db).actions.find(a => a.id === "events.set_subscription_presence")!;
    const input = { subscription_id: "edit", presence: { displayName: "Helper" } };
    expect(await tool.execute(input, context("admin"))).toMatchObject({ success: false });
    expect(await tool.execute(input, context("member", { orgId: "foreign" }))).toMatchObject({ success: false });
    expect(await tool.execute(input, context("member", { externalSender: true }))).toMatchObject({ success: false });
    expect(await tool.execute({ ...input, presence: { avatarUrl: "http://example.com/a" } }, context("member"))).toMatchObject({ success: false });
    expect(await tool.execute(input, context("member"))).toMatchObject({ success: true, data: { subscription: { target: { ...target, appearance: input.presence }, enabled: false } } });
    expect((await db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, "edit")))[0]!.target).toEqual({ ...target, appearance: input.presence });
    expect(await tool.execute({ ...input, presence: null }, context("member"))).toMatchObject({ success: true });
    const [row] = await db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, "edit"));
    expect(row!.target).toEqual(target);
    expect(row!.enabled).toBe(false);
    expect(row!.updatedAt).toBeGreaterThan(now);
    expect(row!.eventKeys).toEqual(["github.pull_request.opened"]);
  });

  it("requires current membership for team subscription reads and writes", async () => {
    const now = Date.now();
    await db.insert(teams).values({ id: "presence-team", orgId: ORG, name: "Team", createdAt: now });
    await db.insert(teamMembers).values({ teamId: "presence-team", userId: "member", role: "member" });
    await db.insert(eventSubscriptions).values({ id: "team-rule", orgId: ORG, ownerType: "team", ownerId: "presence-team", name: "Team rule", eventKeys: [], filters: [], target: { kind: "assistant", assistant: "team", teamId: "presence-team" }, createdBy: "member", createdAt: now, updatedAt: now });
    const plugin = eventsActionPlugin(db);
    const list = plugin.actions.find(a => a.id === "events.list_subscriptions")!;
    const set = plugin.actions.find(a => a.id === "events.set_subscription_presence")!;
    const ctx = context("member", { owner: { type: "team", id: "presence-team" } });
    expect(await list.execute({}, ctx)).toMatchObject({ success: true, data: { subscriptions: [{ id: "team-rule" }] } });
    expect(await set.execute({ subscription_id: "team-rule", presence: { displayName: "Team helper" } }, ctx)).toMatchObject({ success: true });
    await db.delete(teamMembers).where(eq(teamMembers.userId, "member"));
    expect(await list.execute({}, ctx)).toMatchObject({ success: false });
    expect(await set.execute({ subscription_id: "team-rule", presence: null }, ctx)).toMatchObject({ success: false });
    expect((await db.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, "team-rule")))[0]!.target).toMatchObject({ appearance: { displayName: "Team helper" } });
  });

  it("persists the proposal appearance and rejects invalid avatar URLs", async () => {
    const tool = eventsActionPlugin(db, [githubPlugin]).actions.find(a => a.id === "events.propose_subscription")!;
    const input = { proposal_key: "presence", name: "Pulls", event_keys: ["github.pull_request.opened"], presence: { displayName: "PR helper", avatarUrl: "https://example.com/a.webp" } };
    expect(await tool.execute(input, context("member"))).toMatchObject({ success: true, data: { proposal: { config: { target: { appearance: input.presence } } } } });
    expect(await tool.execute({ ...input, proposal_key: "bad-presence", presence: { avatarUrl: "http://example.com/a" } }, context("member"))).toMatchObject({ success: false, error: expect.stringContaining("HTTPS") });
    expect(await db.select().from(eventSubscriptions)).toHaveLength(1);
  });

  it("answers a repeated proposal stored before the rename with the new target names", async () => {
    const tool = eventsActionPlugin(db, [githubPlugin]).actions.find(a => a.id === "events.propose_subscription")!;
    const input = { proposal_key: "legacy", name: "Pulls", event_keys: ["github.pull_request.opened"], presence: { displayName: "PR helper" } };
    expect(await tool.execute(input, context("member"))).toMatchObject({ success: true });
    const [stored] = await db.select().from(eventSubscriptions);
    // Rewrite the row in the names an older api stored.
    await db.update(eventSubscriptions).set({ target: { kind: "orchestrator", orchestrator: "user", presence: { displayName: "PR helper" } } })
      .where(eq(eventSubscriptions.id, stored!.id));
    const repeated = await tool.execute(input, context("member"));
    expect(repeated).toMatchObject({ success: true, data: { proposal: { id: stored!.id, reviewUrl: `/presence/listeners/${stored!.id}`, config: { target: {
      kind: "assistant", assistant: "user", appearance: { displayName: "PR helper" },
    } } } } });
    expect(repeated.data).not.toHaveProperty("proposal.config.target.presence");
    expect(repeated.data).not.toHaveProperty("proposal.config.target.orchestrator");
  });

  it("stores one disabled proposal per owner and preserves enabled configuration on retry", async () => {
    const tool = eventsActionPlugin(db, [githubPlugin]).actions.find(a => a.id === "events.propose_subscription")!;
    const input = { proposal_key: "pulls", name: "Pulls", event_keys: ["github.pull_request.opened"] };
    const results = await Promise.all([tool.execute(input, context("member")), tool.execute(input, context("member"))]);
    for (const result of results) expect(result).toMatchObject({ success: true, data: { proposal: { kind: "subscription", enabled: false, config: { ownerId: "member" } } } });
    const rows = await db.select().from(eventSubscriptions);
    expect(rows).toHaveLength(1);
    await db.update(eventSubscriptions).set({ enabled: true }).where(eq(eventSubscriptions.id, rows[0]!.id));
    expect(await tool.execute(input, context("member"))).toMatchObject({ success: true, data: { proposal: { enabled: true, config: { name: "Pulls" } } } });
    expect(await tool.execute({ ...input, name: "Changed" }, context("member"))).toMatchObject({ success: false, error: expect.stringContaining("new proposal_key") });
    expect(await tool.execute(input, context("admin"))).toMatchObject({ success: true });
    expect(await db.select().from(eventSubscriptions)).toHaveLength(2);
    expect(await tool.execute(input, context("member", { owner: { type: "team", id: "foreign" } }))).toMatchObject({ success: false });
    expect(await db.select().from(eventSubscriptions)).toHaveLength(2);
  });

  it("links a proposal to the enabled subscription it replaces and names it for the reviewer", async () => {
    const now = Date.now();
    await db.insert(eventSubscriptions).values({ id: "live", orgId: ORG, ownerType: "user", ownerId: "member", name: "Replies v1", eventKeys: ["github.pull_request.opened"], filters: [], target: { kind: "assistant", assistant: "user" }, createdBy: "member", createdAt: now, updatedAt: now });
    const tool = eventsActionPlugin(db, [githubPlugin]).actions.find(a => a.id === "events.propose_subscription")!;
    const input = { proposal_key: "replies-v2", name: "Replies v2", event_keys: ["github.pull_request.opened"], system_prompt: "Reply briefly.", replaces: "live" };
    const proposed = await tool.execute(input, context("member"));
    expect(proposed).toMatchObject({ success: true, data: { proposal: { enabled: false, replaces: { id: "live", name: "Replies v1" }, config: { target: { replaces: "live" } } } } });
    // A retry after a person enabled the proposal (which disabled the live
    // version) still answers with the stored proposal.
    const stored = (await db.select().from(eventSubscriptions).where(eq(eventSubscriptions.name, "Replies v2")))[0]!;
    const proposalId = stored.id;
    // The PATCH route's enable: switch on, clear the spent link, record it.
    const { replaces: _spent, ...unlinkedTarget } = stored.target as { replaces?: string };
    await db.update(eventSubscriptions).set({ enabled: true, target: { ...unlinkedTarget, replaced: "live" } }).where(eq(eventSubscriptions.id, proposalId));
    await db.update(eventSubscriptions).set({ enabled: false }).where(eq(eventSubscriptions.id, "live"));
    expect(await tool.execute(input, context("member"))).toMatchObject({ success: true, data: { proposal: { id: proposalId, enabled: true } } });
    // Still the stored record after the new version is turned off, and after
    // the version it replaced is deleted.
    await db.update(eventSubscriptions).set({ enabled: false }).where(eq(eventSubscriptions.id, proposalId));
    expect(await tool.execute(input, context("member"))).toMatchObject({ success: true, data: { proposal: { id: proposalId, enabled: false } } });
    await db.delete(eventSubscriptions).where(eq(eventSubscriptions.id, "live"));
    expect(await tool.execute(input, context("member"))).toMatchObject({ success: true, data: { proposal: { id: proposalId } } });
    // Adding replaces to a proposal stored without a link is a different
    // proposal, not a spent one: the key conflicts.
    const { replaces: _none, ...firstPlain } = input;
    expect(await tool.execute({ ...firstPlain, proposal_key: "plain-first" }, context("member"))).toMatchObject({ success: true });
    expect(await tool.execute({ ...firstPlain, proposal_key: "plain-first", replaces: "live" }, context("member")))
      .toMatchObject({ success: false, error: expect.stringContaining("Use a new proposal_key") });
    // Without replaces, a proposal stores no link, as before.
    const { replaces: _replaces, ...unlinked } = input;
    const plain = await tool.execute({ ...unlinked, proposal_key: "plain" }, context("member"));
    expect(plain).toMatchObject({ success: true, data: { proposal: { enabled: false } } });
    expect(plain.data).not.toHaveProperty("proposal.replaces");
    expect(plain.data).not.toHaveProperty("proposal.config.target.replaces");
  });

  it("refuses a replaces ID that is unknown, in another workspace, or not enabled", async () => {
    const now = Date.now();
    const rule = { eventKeys: ["github.pull_request.opened"], filters: [], target: { kind: "assistant" }, createdAt: now, updatedAt: now };
    await db.insert(orgs).values({ id: "foreign", name: "Foreign", createdAt: now });
    await db.insert(teams).values({ id: "replace-team", orgId: ORG, name: "Team", createdAt: now });
    await db.insert(teamMembers).values({ teamId: "replace-team", userId: "member", role: "member" });
    await db.insert(eventSubscriptions).values([
      { ...rule, id: "colleague", orgId: ORG, ownerType: "user", ownerId: "admin", name: "Colleague", createdBy: "admin" },
      { ...rule, id: "team-rule", orgId: ORG, ownerType: "team", ownerId: "replace-team", name: "Team rule", createdBy: "member" },
      { ...rule, id: "other-org", orgId: "foreign", ownerType: "user", ownerId: "member", name: "Other org", createdBy: "member" },
      { ...rule, id: "parked", orgId: ORG, ownerType: "user", ownerId: "member", name: "Parked", enabled: false, createdBy: "member" },
      { ...rule, id: "trigger", orgId: ORG, ownerType: "user", ownerId: "member", name: "Trigger", target: { kind: "workflow", workflowId: "wf" }, createdBy: "member" },
    ]);
    const tool = eventsActionPlugin(db, [githubPlugin]).actions.find(a => a.id === "events.propose_subscription")!;
    const input = { proposal_key: "refused", name: "Next", event_keys: ["github.pull_request.opened"] };
    // A workflow trigger is not an assistant version, even the caller's own.
    for (const replaces of ["missing", "colleague", "team-rule", "other-org", "trigger"]) {
      expect(await tool.execute({ ...input, replaces }, context("member"))).toMatchObject({ success: false, error: expect.stringContaining("No assistant subscription with this replaces ID exists in this workspace") });
    }
    expect(await tool.execute({ ...input, replaces: "parked" }, context("member"))).toMatchObject({ success: false, error: expect.stringContaining("\"Parked\" is not enabled") });
    expect(await db.select().from(eventSubscriptions)).toHaveLength(5);
  });

  it("persists explicit personal thread preferences and rejects them for team proposals", async () => {
    const tool = eventsActionPlugin(db, [githubPlugin]).actions.find(a => a.id === "events.propose_subscription")!;
    const base = { proposal_key: "thread", name: "Thread", event_keys: ["github.pull_request.opened"] };
    expect(await tool.execute({ ...base, follow: true }, context("member"))).toMatchObject({ success: false, error: expect.stringContaining("slack.app_mention") });
    expect(await db.select().from(eventSubscriptions)).toHaveLength(0);
    const prefs = { follow: false, delivery_policy: "ignoreIfMyTeamSubscribed", pause_on_overlap: false };
    expect(await tool.execute({ ...base, ...prefs }, context("member"))).toMatchObject({
      success: true, data: { proposal: { enabled: false, config: { target: {
        follow: false, deliveryPolicy: "ignoreIfMyTeamSubscribed", pauseOnOverlap: false,
      } } } },
    });
    const [stored] = await db.select().from(eventSubscriptions);
    expect(stored!.target).toMatchObject({ follow: false, deliveryPolicy: "ignoreIfMyTeamSubscribed", pauseOnOverlap: false });
    for (const preference of [{ delivery_policy: "always" }, { pause_on_overlap: false }]) {
      expect(await tool.execute({ ...base, ...preference }, context("member", { owner: { type: "team", id: "team" } }))).toMatchObject({
        success: false, error: expect.stringContaining("personal subscriptions"),
      });
    }
    expect(await db.select().from(eventSubscriptions)).toHaveLength(1);
    await db.insert(teams).values({ id: "follow-team", orgId: ORG, name: "Follow team", createdAt: Date.now() });
    await db.insert(teamMembers).values({ teamId: "follow-team", userId: "member", role: "member" });
    expect(await tool.execute({ ...base, follow: false }, context("member", { owner: { type: "team", id: "follow-team" } }))).toMatchObject({
      success: true, data: { proposal: { config: { target: { assistant: "team", teamId: "follow-team", follow: false } } } },
    });
  });

  function list() {
    const found = eventsActionPlugin(db).actions.find((entry) => entry.id === "events.list_problems");
    if (!found) throw new Error("events.list_problems is not registered");
    return found;
  }

  it("returns a Slack bot-message near-miss with normalized and raw event identities", async () => {
    await db.insert(eventDropLog).values({
      id: "leg17", orgId: ORG, reason: "filter_excluded", eventKey: "slack.message",
      eventMetadata: { channel: "C_FORM", text: "Submitted intake", botId: "B_FORM", rawEventType: "message", rawSubtype: "bot_message" },
      detail: "slack.message accepts only human messages", createdAt: Date.now(),
    });

    const result = await list().execute(
      { event_key: "slack.message", channel: "C_FORM", text: "Submitted intake", bot_id: "B_FORM" },
      context("admin", { owner: { type: "user", id: "admin" } }),
    );
    expect(result.success).toBe(true);
    expect(resultProblems(result)).toEqual([expect.objectContaining({
      receivedAt: expect.any(Number),
      normalizedEventKey: "slack.message",
      matchOutcome: "excluded_by_filter",
      reason: "filter_excluded",
      payloadMetadata: expect.objectContaining({ rawSubtype: "bot_message", rawEventType: "message", channel: "C_FORM", botId: "B_FORM" }),
    })]);
  });

  it("applies member redaction and excludes admin-only interaction diagnostics", async () => {
    await db.insert(eventDropLog).values([
      { id: "filter", orgId: ORG, reason: "filter_excluded", eventKey: "slack.message", eventMetadata: { channel: "C1", text: "private", botId: "B1" }, detail: "filtered", createdAt: 2_000 },
      { id: "interaction", orgId: ORG, reason: "slack_interaction_unmatched", detail: "form details", createdAt: 1_000 },
    ]);

    const member = await list().execute({}, context("member"));
    expect(member.success).toBe(true);
    expect(resultProblems(member)).toEqual([expect.objectContaining({ id: "filter", payloadMetadata: { channel: "C1" } })]);
    const restricted = await list().execute({ text: "private" }, context("member"));
    expect(restricted).toMatchObject({ success: false, error: expect.stringMatching(/organization admin/) });
  });

  it("redacts administrator-only metadata in a team-owned transcript", async () => {
    await db.insert(eventDropLog).values({
      id: "team-secret", orgId: ORG, reason: "filter_excluded", eventKey: "slack.message",
      eventMetadata: { channel: "C1", text: "secret payroll message", botId: "B_SECRET" },
      detail: "filtered", createdAt: Date.now(),
    });
    const teamContext = context("admin", {
      actor: { id: "admin" },
      owner: { type: "team", id: "finance-team" },
    });

    const result = await list().execute({}, teamContext);
    expect(result.success).toBe(true);
    expect(resultProblems(result)).toEqual([expect.objectContaining({
      payloadMetadata: { channel: "C1" },
    })]);
    expect(JSON.stringify(result)).not.toContain("secret payroll message");
    expect(JSON.stringify(result)).not.toContain("B_SECRET");
    expect(await list().execute({ text: "secret payroll message" }, teamContext)).toMatchObject({
      success: false,
      error: expect.stringMatching(/private session/),
    });
  });

  it("redacts administrator-only metadata in a channel-originated user transcript", async () => {
    await db.insert(eventDropLog).values([
      {
        id: "channel-secret", orgId: ORG, reason: "filter_excluded", eventKey: "slack.message",
        eventMetadata: { channel: "C1", text: "secret payroll message", botId: "B_SECRET", rawEventType: "message" },
        detail: "filtered", createdAt: 2_000,
      },
      {
        id: "channel-interaction", orgId: ORG, reason: "slack_interaction_unmatched",
        detail: "form details", createdAt: 1_000,
      },
    ]);
    const channelContext = context("admin", {
      actor: { id: "admin" },
      owner: { type: "user", id: "admin" },
      origin: { channelType: "slack", threadKey: "slack:C1:1.2" },
    });

    const result = await list().execute({}, channelContext);
    expect(result.success).toBe(true);
    expect(resultProblems(result)).toEqual([expect.objectContaining({
      id: "channel-secret",
      payloadMetadata: { channel: "C1", rawEventType: "message" },
    })]);
    expect(JSON.stringify(result)).not.toContain("secret payroll message");
    expect(JSON.stringify(result)).not.toContain("B_SECRET");
    expect(await list().execute({ text: "secret payroll message" }, channelContext)).toMatchObject({
      success: false,
      error: expect.stringMatching(/private session/),
    });
    expect(await list().execute({ bot_id: "B_SECRET" }, channelContext)).toMatchObject({
      success: false,
      error: expect.stringMatching(/private session/),
    });
  });

  it("fails closed for organization-owned and owner-absent transcripts", async () => {
    await db.insert(eventDropLog).values([
      {
        id: "shared-secret", orgId: ORG, reason: "filter_excluded", eventKey: "slack.message",
        eventMetadata: { channel: "C1", text: "secret payroll message", botId: "B_SECRET" },
        detail: "filtered", createdAt: 2_000,
      },
      {
        id: "shared-interaction", orgId: ORG, reason: "slack_interaction_unmatched",
        detail: "form details", createdAt: 1_000,
      },
    ]);
    const contexts = [
      context("admin", { actor: { id: "admin" }, owner: { type: "org", id: ORG } }),
      context("admin", { actor: { id: "admin" } }),
    ];

    for (const sharedContext of contexts) {
      const result = await list().execute({}, sharedContext);
      expect(result.success).toBe(true);
      expect(resultProblems(result)).toEqual([expect.objectContaining({
        id: "shared-secret",
        payloadMetadata: { channel: "C1" },
      })]);
      expect(JSON.stringify(result)).not.toContain("secret payroll message");
      expect(JSON.stringify(result)).not.toContain("B_SECRET");
      expect(await list().execute({ bot_id: "B_SECRET" }, sharedContext)).toMatchObject({
        success: false,
        error: expect.stringMatching(/private session/),
      });
    }
  });

  it("reports no match outcome for non-event diagnostics", async () => {
    await db.insert(eventDropLog).values({
      id: "unbound", orgId: ORG, reason: "unbound_channel", detail: "Channel is not bound", createdAt: Date.now(),
    });

    const result = await list().execute({}, context("admin", { owner: { type: "user", id: "admin" } }));
    expect(result.success).toBe(true);
    expect(resultProblems(result)).toEqual([expect.objectContaining({
      id: "unbound",
      matchOutcome: null,
    })]);
  });

  it("scopes records to the caller organization and respects time and limit filters", async () => {
    await db.insert(eventDropLog).values([
      { id: "old", orgId: ORG, reason: "filter_excluded", eventKey: "slack.message", detail: "old", createdAt: 1_000 },
      { id: "first", orgId: ORG, reason: "filter_excluded", eventKey: "slack.message", detail: "first", createdAt: 2_000 },
      { id: "second", orgId: ORG, reason: "filter_excluded", eventKey: "slack.message", detail: "second", createdAt: 3_000 },
      { id: "foreign", orgId: "other-org", reason: "filter_excluded", eventKey: "slack.message", detail: "foreign", createdAt: 4_000 },
    ]);

    const result = await list().execute({ event_key: "slack.message", since: 1_500, until: 3_000, limit: 1 }, context("admin"));
    expect(result.success).toBe(true);
    expect(resultProblems(result).map((problem) => problem.id)).toEqual(["second"]);
  });

  it("filters metadata in SQL before applying the default limit", async () => {
    const rows = Array.from({ length: 26 }, (_, index) => ({
      id: `newer-${index}`,
      orgId: ORG,
      reason: "filter_excluded",
      eventKey: "slack.message",
      eventMetadata: { channel: "C_OTHER" },
      detail: "other channel",
      createdAt: 10_000 - index,
    }));
    rows.push({
      id: "older-match",
      orgId: ORG,
      reason: "filter_excluded",
      eventKey: "slack.message",
      eventMetadata: { channel: "C_FORM" },
      detail: "form channel",
      createdAt: 1_000,
    });
    await db.insert(eventDropLog).values(rows);

    const result = await list().execute({ channel: "C_FORM" }, context("admin"));
    expect(result.success).toBe(true);
    expect(resultProblems(result).map((problem) => problem.id)).toEqual(["older-match"]);
  });

  it("rejects unsafe timestamp filters before binding them to PostgreSQL", async () => {
    const tooLarge = await list().execute({ since: 1e100 }, context("admin"));
    expect(tooLarge).toMatchObject({ success: false, error: expect.stringMatching(/safe epoch-millisecond/) });

    const outOfRange = await list().execute({ until: Number.MAX_SAFE_INTEGER + 1 }, context("admin"));
    expect(outOfRange).toMatchObject({ success: false, error: expect.stringMatching(/safe epoch-millisecond/) });
  });

  it("refuses a context whose user is not an organization member", async () => {
    const result = await list().execute({}, context("not-a-member"));
    expect(result).toMatchObject({ success: false, error: "You are not a member of this organization." });
  });
  it("keeps receipt access out of member and shared transcripts", async () => {
    const logs = eventsActionPlugin(db).actions.find(entry => entry.id === "events.list_event_logs")!;
    for (const ctx of [
      context("member", { owner: { type: "user", id: "member" } }),
      context("admin", { owner: { type: "team", id: "team" } }),
      context("admin", { owner: { type: "user", id: "admin" }, sharedTranscript: true }),
      context("admin"),
    ]) {
      expect(await logs.execute({}, ctx)).toMatchObject({ success: false });
    }
  });

  it("scopes receipt logs by organization and retention and sanitizes metadata", async () => {
    const now = Date.now();
    await db.insert(eventReceipts).values([
      { id: "visible", orgId: ORG, service: "slack", createdAt: now, updatedAt: now, metadata: { channelId: "C1", secret: "must-not-return" } },
      { id: "other-org", orgId: "different-org", service: "slack", createdAt: now, updatedAt: now },
      { id: "expired", orgId: ORG, service: "slack", createdAt: now - 8 * 86400000, updatedAt: now },
    ]);
    const logs = eventsActionPlugin(db).actions.find(entry => entry.id === "events.list_event_logs")!;
    const result = await logs.execute({}, context("admin", { owner: { type: "user", id: "admin" } }));
    expect(result).toMatchObject({ success: true, data: { receipts: [{ id: "visible", metadata: { channelId: "C1" } }], hasMore: false } });
    expect(JSON.stringify(result)).not.toContain("must-not-return");
    expect(JSON.stringify(result)).not.toContain("other-org");
    expect(JSON.stringify(result)).not.toContain("expired");
  });

});
