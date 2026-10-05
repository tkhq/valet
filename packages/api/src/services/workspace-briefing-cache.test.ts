import { InMemoryCredentialStore } from "@valet/engine";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { actionInvocations, agentSessions, artifacts, sessionThreads, slackChannelPrivacy, workflowDefinitions, workflowRuns, workspaceBriefingCache } from "../schema/index.js";
import type { WorkspaceBriefingsResponse } from "../wire/types.js";
import { collectWorkspaceBriefingSources, type BriefingEvidence } from "./workspace-briefing-sources.js";
import { briefingEvidenceHash, createDurableBriefingCache } from "./workspace-briefing-cache.js";
import { canReadCachedBriefingSources } from "./workspace-briefing-cache-access.js";

const owner = { type: "user" as const, id: "local-user" };
const evidence: BriefingEvidence[] = [{ source: { id: "thread:s:t", kind: "thread", title: "Goal", sessionId: "s", threadId: "t", updatedAt: 10 }, content: "Awaiting verification.", state: "updated" }];
const snapshot: WorkspaceBriefingsResponse = { briefings: [{ id: "brief", title: "Goal", summary: "Awaiting verification.", status: "updated", updatedAt: 10,
  latestThread: { sessionId: "s", threadId: "t" }, sources: evidence.map(item => item.source) }], generatedAt: 1000, coverage: "recent" };
let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });
async function setup() { api = await bootTestApi(); return api.providers.db; }
const valid = async () => true;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

describe("durable workspace briefing cache", () => {
  it("reuses persisted responses across instances and checks evidence only at the cadence", async () => {
    const db = await setup(); let clock = 1000;
    const collect = vi.fn(async () => evidence);
    const generate = vi.fn(async () => snapshot);
    const options = { version: "v1", collect, generate, validate: valid, now: () => clock };
    const first = createDurableBriefingCache(options);
    const credentials = new InMemoryCredentialStore();
    expect((await first(db,"local-org",owner,credentials)).generatedAt).toBe(1000);
    // Generation reaches the organization's models through the caller's credential store.
    expect(generate).toHaveBeenCalledWith("local-org", owner, evidence, { db, credentials });
    const restarted = createDurableBriefingCache(options);
    expect((await restarted(db,"local-org",owner)).checkedAt).toBe(1000);
    expect(collect).toHaveBeenCalledTimes(1); expect(generate).toHaveBeenCalledTimes(1);
    clock += 60_001;
    expect((await restarted(db,"local-org",owner)).checkedAt).toBe(clock);
    expect(collect).toHaveBeenCalledTimes(2); expect(generate).toHaveBeenCalledTimes(1);
    await createDurableBriefingCache({ ...options, version: "v2" })(db,"local-org",owner);
    expect(generate).toHaveBeenCalledTimes(2);
    await restarted(db,"other-org",owner);
    await restarted(db,"local-org",{ type: "team", id: "team" });
    expect(generate).toHaveBeenCalledTimes(4);
  });
  it("keeps showing the old snapshot while replicas coalesce on one background refresh", async () => {
    const db = await setup(); let clock = 1000;
    const pending = deferred<WorkspaceBriefingsResponse>();
    const collect = vi.fn(async () => evidence);
    const generate = vi.fn(async () => snapshot);
    const options = { version: "v1", collect, generate, validate: valid, now: () => clock, minRegenerateMs: 0 };
    const first = createDurableBriefingCache(options); const second = createDurableBriefingCache(options);
    await first(db,"local-org",owner);
    clock += 60_001;
    collect.mockResolvedValue([{ ...evidence[0], content: "New conclusion." }]);
    generate.mockImplementation(() => pending.promise);
    expect(await first(db,"local-org",owner)).toMatchObject({ generatedAt: 1000, refreshing: true });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(await second(db,"local-org",owner)).toMatchObject({ briefings: snapshot.briefings, generatedAt: 1000, refreshing: true });
    expect(collect).toHaveBeenCalledTimes(2);
    pending.resolve({ ...snapshot, generatedAt: clock });
    await vi.waitFor(async () => expect((await second(db,"local-org",owner)).generatedAt).toBe(clock));
    expect((await second(db,"local-org",owner)).refreshing).toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it("keeps a young snapshot, and keeps the shown snapshot when a refresh fails", async () => {
    const db = await setup(); let clock = 1000;
    const collect = vi.fn(async () => evidence);
    const generate = vi.fn(async (): Promise<WorkspaceBriefingsResponse> => snapshot);
    const cached = createDurableBriefingCache({ version: "v1", collect, generate, validate: valid, now: () => clock, minRegenerateMs: 300_000 });
    await cached(db,"local-org",owner);
    collect.mockResolvedValue([{ ...evidence[0], content: "New conclusion." }]);
    clock += 60_001;
    expect((await cached(db,"local-org",owner)).generatedAt).toBe(1000);
    expect(generate).toHaveBeenCalledTimes(1);
    clock = 1000 + 300_000;
    generate.mockResolvedValue({ briefings: [], generatedAt: null, coverage: "recent", unavailable: true });
    expect((await cached(db,"local-org",owner)).refreshing).toBe(true);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect((await cached(db,"local-org",owner)).refreshing).toBeUndefined());
    expect(await cached(db,"local-org",owner)).toMatchObject({ briefings: snapshot.briefings, generatedAt: 1000 });
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it("backs off failed generations across instances without repeated source or model reads", async () => {
    const db = await setup(); let clock = 1000;
    const collect = vi.fn(async () => evidence);
    const generate = vi.fn(async (): Promise<WorkspaceBriefingsResponse> => ({ briefings: [], generatedAt: null, coverage: "recent", unavailable: true }));
    const options = { version: "v1", collect, generate, validate: valid, now: () => clock };
    expect((await createDurableBriefingCache(options)(db,"local-org",owner)).unavailable).toBe(true);
    const another = createDurableBriefingCache(options);
    await another(db,"local-org",owner); await another(db,"local-org",owner);
    expect(generate).toHaveBeenCalledTimes(1); expect(collect).toHaveBeenCalledTimes(1);
    clock += 60_001;
    generate.mockResolvedValue(snapshot);
    expect((await another(db,"local-org",owner)).unavailable).toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it("fences an expired worker so it cannot overwrite a newer replica's result", async () => {
    const db = await setup(); let clock = 1000;
    const pending = deferred<WorkspaceBriefingsResponse>();
    const generate = vi.fn(() => pending.promise);
    const options = { version: "v1", collect: async () => evidence, generate, validate: valid, now: () => clock, leaseMs: 100 };
    const stale = createDurableBriefingCache(options)(db,"local-org",owner);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    clock += 101;
    const newest = { ...snapshot, generatedAt: 2000 };
    await createDurableBriefingCache({ ...options, generate: async () => newest })(db,"local-org",owner);
    pending.resolve(snapshot);
    expect((await stale).generatedAt).toBe(2000);
    expect((await db.select().from(workspaceBriefingCache))[0].response?.generatedAt).toBe(2000);
  });
  it("revalidates source ownership on fresh hits and after generation", async () => {
    const db = await setup();
    await db.insert(agentSessions).values({ id: "s", orgId: "local-org", userId: "local-user", ownerType: "user", ownerId: "local-user", workspace: "w", createdAt: 1, updatedAt: 1 });
    await db.insert(sessionThreads).values({ id: "t", sessionId: "s", createdAt: 1 });
    const collect = vi.fn(async () => evidence);
    const cached = createDurableBriefingCache({ version: "v1", collect, generate: async () => snapshot });
    expect((await cached(db,"local-org",owner)).briefings).toHaveLength(1);
    await db.update(agentSessions).set({ ownerId: "test-member" }).where(eq(agentSessions.id,"s"));
    expect(await cached(db,"local-org",owner)).toMatchObject({ briefings: [], unavailable: true });
    expect(collect).toHaveBeenCalledTimes(1);
    await db.update(agentSessions).set({ ownerId: "local-user" }).where(eq(agentSessions.id,"s"));
    const pending = deferred<WorkspaceBriefingsResponse>();
    const generate = vi.fn(() => pending.promise);
    const started = createDurableBriefingCache({ version: "v2", collect, generate })(db,"local-org",owner);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await db.update(agentSessions).set({ status: "deleted" }).where(eq(agentSessions.id,"s"));
    pending.resolve(snapshot);
    expect(await started).toMatchObject({ briefings: [], unavailable: true });
    expect((await db.select().from(workspaceBriefingCache).where(and(eq(workspaceBriefingCache.orgId,"local-org"),eq(workspaceBriefingCache.ownerId,owner.id))))[0].response).toBeNull();
  });
  it("rejects revoked artifact sources and moved workflow sources without scanning their bodies", async () => {
    const db = await setup();
    await db.insert(artifacts).values({ id: "a", token: "token", orgId: "local-org", ownerType: "user", ownerId: owner.id, actorUserId: owner.id, sourceMemoryPath: "a", content: "private", createdAt: 1, updatedAt: 1 });
    await db.insert(workflowDefinitions).values({ id: "w", orgId: "local-org", ownerType: "user", ownerId: owner.id, name: "w", definition: {}, createdAt: 1, updatedAt: 1 });
    await db.insert(workflowRuns).values({ id: "r", workflowId: "w", definitionVersionId: "v", definition: {}, params: {}, ownerType: "user", ownerId: owner.id, createdAt: 1, updatedAt: 1 });
    const response: WorkspaceBriefingsResponse = { ...snapshot, briefings: [{ ...snapshot.briefings[0], latestThread: null, sources: [
      { id: "artifact:a", kind: "artifact", token: "token", title: "a", updatedAt: 1 },
      { id: "workflow:r", kind: "workflow", runId: "r", title: "r", updatedAt: 1 },
    ] }] };
    expect(await canReadCachedBriefingSources(db,"local-org",owner,response)).toBe(true);
    await db.update(artifacts).set({ revokedAt: 2 }).where(eq(artifacts.id,"a"));
    expect(await canReadCachedBriefingSources(db,"local-org",owner,response)).toBe(false);
    await db.update(artifacts).set({ revokedAt: null }).where(eq(artifacts.id,"a"));
    await db.update(workflowRuns).set({ ownerType: "team", ownerId: "another" }).where(eq(workflowRuns.id,"r"));
    expect(await canReadCachedBriefingSources(db,"local-org",owner,response)).toBe(false);
  });
  it("stops serving a cached team briefing once a source's Slack channel turns private", async () => {
    const db = await setup();
    const team = { type: "team" as const, id: "team-brief" };
    await db.insert(agentSessions).values({ id: "team-rt", orgId: "local-org", userId: "local-user", ownerType: "team", ownerId: team.id, workspace: "w", createdAt: 1, updatedAt: 1 });
    await db.insert(sessionThreads).values({ id: "slack-th", sessionId: "team-rt", createdAt: 1 });
    await db.execute(sql`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, created_at, updated_at)
      VALUES ('slack-th', 'team-rt', 'slack:CFLIP:1.1', 'idle', 'steer', 1, 1)`);
    await db.insert(slackChannelPrivacy).values({ orgId: "local-org", channelId: "CFLIP", isPrivate: false, checkedAt: Date.now() });
    const response: WorkspaceBriefingsResponse = { generatedAt: 1, coverage: "recent", briefings: [{ id: "b", title: "t", summary: "s", status: "updated", updatedAt: 1,
      latestThread: { sessionId: "team-rt", threadId: "slack-th" },
      sources: [{ id: "thread:team-rt:slack-th", kind: "thread", sessionId: "team-rt", threadId: "slack-th", title: "t", updatedAt: 1 }] }] };
    expect(await canReadCachedBriefingSources(db,"local-org",team,response)).toBe(true);
    await db.update(slackChannelPrivacy).set({ isPrivate: true }).where(eq(slackChannelPrivacy.channelId,"CFLIP"));
    expect(await canReadCachedBriefingSources(db,"local-org",team,response)).toBe(false);
  });
  it("rechecks stored run origins even when cached links omit the source thread", async () => {
    const db = await setup();
    const team = { type: "team" as const, id: "team-brief" };
    await db.insert(agentSessions).values({ id: "rt", orgId: "local-org", userId: "local-user", ownerType: "team", ownerId: team.id, workspace: "w", createdAt: 1, updatedAt: 1 });
    await db.insert(sessionThreads).values({ id: "th", sessionId: "rt", createdAt: 1 });
    await db.execute(sql`INSERT INTO engine_threads (id,session_id,key,status,queue_mode,created_at,updated_at)
      VALUES ('th','rt','app-assistant:local-user','idle','steer',1,1)`);
    await db.insert(workflowDefinitions).values({ id: "w", orgId: "local-org", ownerType: "team", ownerId: team.id, name: "w", definition: {}, createdAt: 1, updatedAt: 1 });
    await db.insert(workflowRuns).values({ id: "r", workflowId: "w", definitionVersionId: "v", definition: {}, params: {}, ownerType: "team", ownerId: team.id,
      status: "parked", waitingOn: [{ kind: "signal", nodeId: "n", signalType: "approval:n" }], createdAt: 1, updatedAt: 1 });
    const response: WorkspaceBriefingsResponse = { ...snapshot, briefings: [{ ...snapshot.briefings[0], latestThread: null,
      sources: [{ id: "workflow:r", kind: "workflow", runId: "r", title: "r", updatedAt: 1 }] }] };
    for (const [params, allowed] of [
      [{}, true],
      [{ origin: { assistantSessionId: "rt", threadId: "th" } }, false],
      [{ origin: { assistantSessionId: "rt", threadId: "gone" } }, false],
      [{ origin: { assistantSessionId: "rt" } }, false],
    ] as const) {
      await db.update(workflowRuns).set({ params }).where(eq(workflowRuns.id,"r"));
      expect(await canReadCachedBriefingSources(db,"local-org",team,response)).toBe(allowed);
      expect((await collectWorkspaceBriefingSources(db,"local-org",team)).some(item => item.source.runId === "r")).toBe(allowed);
    }
    await db.execute(sql`UPDATE engine_threads SET key='slack:CPUBLIC:1' WHERE session_id='rt' AND id='th'`);
    await db.insert(slackChannelPrivacy).values({ orgId: "local-org", channelId: "CPUBLIC", isPrivate: false, checkedAt: Date.now() });
    await db.update(workflowRuns).set({ params: { origin: { assistantSessionId: "rt", threadId: "th" } } }).where(eq(workflowRuns.id,"r"));
    expect(await canReadCachedBriefingSources(db,"local-org",team,response)).toBe(true);
    expect((await collectWorkspaceBriefingSources(db,"local-org",team)).some(item => item.source.runId === "r")).toBe(true);
    await db.update(sessionThreads).set({ archivedAt: 2 }).where(eq(sessionThreads.id,"th"));
    expect(await canReadCachedBriefingSources(db,"local-org",team,response)).toBe(false);
    expect((await collectWorkspaceBriefingSources(db,"local-org",team)).some(item => item.source.runId === "r")).toBe(false);
    await db.insert(actionInvocations).values({ invocationId: "effect", sessionId: "wf:r:step", workflowExecutionId: "r",
      orgId: "local-org", createdAt: 100, durationMs: 1, actionId: "github.create_pull_request", status: "completed",
      result: { success: true, data: { title: "Private effect", html_url: "https://github.com/acme/app/pull/1" } } });
    // Event-only runs have no presentation thread either.
    await db.update(workflowRuns).set({ params: { input: { data: { key: "slack.message", refs: { channel: "CPUBLIC" } } } } }).where(eq(workflowRuns.id,"r"));
    expect(await canReadCachedBriefingSources(db,"local-org",team,response)).toBe(true);
    expect((await collectWorkspaceBriefingSources(db,"local-org",team)).some(item => item.source.id === "action:effect")).toBe(true);
    // No viewer needs to open the channel for stale event/run evidence to expire.
    await db.update(slackChannelPrivacy).set({ checkedAt: Date.now() - 5 * 60_000 }).where(eq(slackChannelPrivacy.channelId,"CPUBLIC"));
    expect(await canReadCachedBriefingSources(db,"local-org",team,response)).toBe(false);
    expect(await collectWorkspaceBriefingSources(db,"local-org",team)).toEqual([]);
    await db.update(slackChannelPrivacy).set({ checkedAt: Date.now() }).where(eq(slackChannelPrivacy.channelId,"CPUBLIC"));
    expect(await canReadCachedBriefingSources(db,"local-org",team,response)).toBe(true);
    await db.update(slackChannelPrivacy).set({ isPrivate: true }).where(eq(slackChannelPrivacy.channelId,"CPUBLIC"));
    expect(await canReadCachedBriefingSources(db,"local-org",team,response)).toBe(false);
    expect(await collectWorkspaceBriefingSources(db,"local-org",team)).toEqual([]);
  });
  it("checks stored artifact origins when cached presentation links are absent", async () => {
    const db = await setup();
    const team = { type: "team" as const, id: "team-brief" };
    await db.insert(artifacts).values({ id: "a", token: "token", orgId: "local-org", ownerType: "team", ownerId: team.id,
      actorUserId: "local-user", sourceMemoryPath: "a", sourceSessionId: "gone", sourceThreadId: "gone", content: "private", createdAt: 1, updatedAt: 1 });
    const response: WorkspaceBriefingsResponse = { ...snapshot, briefings: [{ ...snapshot.briefings[0], latestThread: null,
      sources: [{ id: "artifact:a", kind: "artifact", token: "token", title: "a", updatedAt: 1 }] }] };
    expect(await canReadCachedBriefingSources(db,"local-org",team,response)).toBe(false);
    expect(await collectWorkspaceBriefingSources(db,"local-org",team)).toEqual([]);
    await db.insert(agentSessions).values({ id: "gone", orgId: "local-org", userId: "local-user", ownerType: "team", ownerId: team.id, workspace: "w", createdAt: 1, updatedAt: 1 });
    await db.insert(sessionThreads).values({ id: "gone", sessionId: "gone", createdAt: 1 });
    await db.execute(sql`INSERT INTO engine_entries(id,session_id,thread_id,entry_type,role,content,created_at)
      VALUES ('orphan','gone','gone','message','user','Private orphan narrative',1)`);
    expect(await collectWorkspaceBriefingSources(db,"local-org",team)).toEqual([]);
    await db.execute(sql`INSERT INTO engine_threads (id,session_id,key,status,queue_mode,created_at,updated_at)
      VALUES ('gone','gone','main','idle','steer',1,1)`);
    expect(await canReadCachedBriefingSources(db,"local-org",team,response)).toBe(true);
    expect((await collectWorkspaceBriefingSources(db,"local-org",team)).some(item => item.source.id === "artifact:a")).toBe(true);
  });
  it("hashes semantic changes but ignores source ordering and non-conversation heartbeats", () => {
    const run: BriefingEvidence = { source: { id: "run", kind: "workflow", title: "Run", runId: "r", updatedAt: 10 }, content: "Awaiting approval.", state: "needs_attention" };
    expect(briefingEvidenceHash([...evidence,run])).toBe(briefingEvidenceHash([{ ...run, source: { ...run.source, updatedAt: 20 } },...evidence]));
    expect(briefingEvidenceHash(evidence)).not.toBe(briefingEvidenceHash([{ ...evidence[0], content: "Changed" }]));
    expect(briefingEvidenceHash(evidence)).not.toBe(briefingEvidenceHash([{ ...evidence[0], source: { ...evidence[0].source, updatedAt: 20 } }]));
  });
});
