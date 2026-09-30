import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, artifacts, sessionThreads, workflowCheckpoints, workflowDefinitions, workflowRuns } from "../schema/index.js";
import { budgetBriefingEvidence, collectWorkspaceBriefingSources, slackUrlForThreadKey, type BriefingEvidence } from "./workspace-briefing-sources.js";
import { briefingModelSpec, defaultBriefingSummarizer, createBriefingGenerator, withoutInternalIds, parseWorkspaceBriefings, type BriefingSummarizer } from "./workspace-briefings.js";

const user = { type: "user" as const, id: "local-user" };
const evidence: BriefingEvidence[] = [
  { source: { id: "first", kind: "thread", title: "[Local demo] TKAI-559 request", updatedAt: 10, sessionId: "work", threadId: "request" }, content: "Fix intake deduplication to prevent duplicate work.", state: "updated" },
  { source: { id: "latest", kind: "thread", title: "Verification", updatedAt: 20, sessionId: "runtime", threadId: "verify" }, content: "TKAI-559 works with sequential deliveries. Concurrent verification still needs approval.", state: "needs_attention" },
  { source: { id: "run", kind: "workflow", title: "Check TKAI-559", updatedAt: 25, runId: "run" }, content: "Sequential check passed. Concurrent deliveries remain untested.", state: "updated" },
  { source: { id: "artifact", kind: "artifact", title: "Notes", updatedAt: 30, sessionId: "work", threadId: "request", token: "token" }, content: "Published notes on TKAI-559.", state: "updated" },
];
const pr: BriefingEvidence = { source: { id: "pr", kind: "pull_request", title: "Deduplicate intake", updatedAt: 26 }, content: "Pull request opened.", state: "updated" };
const answer = JSON.stringify({ briefings: [{ title: "Intake deduplication",
  summary: "Sequential deliveries pass. Approve the concurrent check before release.", sourceIds: ["first","latest","run","artifact"] }] });

describe("workspace briefing synthesis", () => {
  it("reads fenced JSON when the model appends an explanation", () => {
    const wrapped = `\`\`\`json\n${answer}\n\`\`\`\n\nThese sources describe the same goal.`;
    expect(parseWorkspaceBriefings(wrapped,evidence)).toEqual(parseWorkspaceBriefings(answer,evidence));
    expect(parseWorkspaceBriefings('```json\n{"briefings":[]}\n```\n\nNo substantive goal has evidence.',evidence)).toEqual([]);
    expect(() => parseWorkspaceBriefings(wrapped.replace('"first"','"made-up"'),evidence)).toThrow("Unknown briefing source");
  });
  it("groups evidence from two conversations and a run while the server chooses the latest conversation", () => {
    const [brief] = parseWorkspaceBriefings(answer,evidence);
    expect(brief).toMatchObject({ title: "[Demo] Intake deduplication", status: "needs_attention", updatedAt: 30,
      latestThread: { sessionId: "runtime", threadId: "verify", title: "Verification" } });
    expect(brief.sources.map(s => s.id)).toEqual(["artifact","run","latest","first"]);
    expect(brief.id).toBe(parseWorkspaceBriefings(answer,[...evidence].reverse())[0].id);
  });
  it("rejects invented source IDs and prose links, and never invents a thread for run-only evidence", () => {
    expect(() => parseWorkspaceBriefings(answer.replace('"first"','"made-up"'),evidence)).toThrow("Unknown briefing source");
    expect(() => parseWorkspaceBriefings(answer.replace("Intake deduplication","https://evil.example"),evidence)).toThrow();
    const withPr = [...evidence, pr];
    const runAndPr = JSON.stringify({ briefings: [{ title: "Intake verification", summary: "Concurrent deliveries remain untested.", sourceIds: ["run","pr"] }] });
    expect(parseWorkspaceBriefings(runAndPr,withPr)[0].latestThread).toBeNull();
  });
  it("never shows an internal id in brief text", () => {
    expect(withoutInternalIds("Choose the first workflow for wf_mun9pbd4w3ev5i")).toBe("Choose the first workflow for the workflow");
    expect(withoutInternalIds("Open `th-mun9pbh1-2` and retry wfrun_abc123def")).toBe("Open the thread and retry the run");
    expect(withoutInternalIds("Keep gpt-5.6 and TKAI-42")).toBe("Keep gpt-5.6 and TKAI-42");
    const reply = JSON.stringify({ briefings: [{ title: "Intake", summary: "Waiting on wf_mun9pbd4w3ev5i.", nextAction: "Name wf_mun9pbd4w3ev5i", sourceIds: ["latest","run"] }] });
    const [brief] = parseWorkspaceBriefings(reply,evidence);
    expect(brief.summary).toBe("Waiting on the workflow.");
    expect(brief.nextAction).toBe("Name the workflow");
  });
  it("keeps a short next action and drops one with a link", () => {
    const reply = (nextAction: string) => JSON.stringify({ briefings: [{ title: "Intake", summary: "The fix is in review.", nextAction, sourceIds: ["latest","run"] }] });
    expect(parseWorkspaceBriefings(reply("Approve the concurrent check."),evidence)[0].nextAction).toBe("Approve the concurrent check.");
    expect(parseWorkspaceBriefings(reply("Open https://evil.example now"),evidence)[0].nextAction).toBeUndefined();
  });
  it("writes briefs with the organization's s tier, unless a model or tier is configured", () => {
    expect(briefingModelSpec({})).toBe("s");
    expect(briefingModelSpec({ VALET_BRIEFING_MODEL: "anthropic/claude-sonnet-5-5" })).toBe("anthropic/claude-sonnet-5-5");
    expect(briefingModelSpec({ VALET_BRIEFING_MODEL: "  " })).toBe("s");
  });
  it("refuses to write briefs without the organization's credential store", async () => {
    await expect(defaultBriefingSummarizer([], new AbortController().signal, { orgId: "o1" })).rejects.toThrow(/credential store/);
  });
  it("keeps only lines of work that combine more than one kind of source", () => {
    const reply = JSON.stringify({ briefings: [
      { title: "Two conversations", summary: "Both conversations discuss intake.", sourceIds: ["first","latest"] },
      { title: "Run only", summary: "The check ran.", sourceIds: ["run"] },
      { title: "Conversation and run", summary: "The run checked the fix.", sourceIds: ["latest","run"] },
    ] });
    expect(parseWorkspaceBriefings(reply,evidence).map(brief => brief.title)).toEqual(["Conversation and run"]);
  });
  it("links a brief without a conversation source to the conversation and Slack thread its run names", () => {
    const run: BriefingEvidence = { source: { id: "slack-run", kind: "workflow", title: "Intake", updatedAt: 40, runId: "slack-run",
      sessionId: "runtime", threadId: "origin-thread", originUrl: "https://slack.com/archives/C1/p1700000000000100" },
      content: "Triaged the request.", state: "updated" };
    const reply = JSON.stringify({ briefings: [{ title: "Intake triage", summary: "The request was triaged.", sourceIds: ["slack-run","pr"] }] });
    const [brief] = parseWorkspaceBriefings(reply,[run,pr]);
    expect(brief.latestThread).toMatchObject({ sessionId: "runtime", threadId: "origin-thread" });
    expect(brief.originUrl).toBe("https://slack.com/archives/C1/p1700000000000100");
  });
  it("builds a Slack permalink only from a Slack thread key", () => {
    expect(slackUrlForThreadKey("slack:C0123:1700000000.000100")).toBe("https://slack.com/archives/C0123/p1700000000000100");
    expect(slackUrlForThreadKey("web:abc")).toBeUndefined();
    expect(slackUrlForThreadKey("slack:C0123:not-a-ts")).toBeUndefined();
    expect(slackUrlForThreadKey(null)).toBeUndefined();
  });
  it("coalesces identical requests and binds the cache to full evidence, org and owner", async () => {
    let release: ((value: string) => void) | undefined;
    const summarize = vi.fn<BriefingSummarizer>(() => new Promise(resolve => { release = resolve; }));
    const generate = createBriefingGenerator({ summarize, now: () => 123 });
    const first = generate("org",user,evidence);
    const second = generate("org",user,evidence);
    expect(summarize).toHaveBeenCalledTimes(1);
    release?.(answer);
    expect(await first).toEqual(await second);
    expect((await generate("org",user,evidence)).generatedAt).toBe(123);
    expect(summarize).toHaveBeenCalledTimes(1);
    summarize.mockResolvedValue(answer);
    await generate("other-org",user,evidence);
    await generate("org",{ type: "team", id: "team" },evidence);
    await generate("org",user,evidence.map((item,i) => i === 0 ? { ...item, content: `${item.content} New evidence.` } : item));
    expect(summarize).toHaveBeenCalledTimes(4);
  });
  it("bounds successful cache entries and retries failures without returning a transcript dump", async () => {
    const summarize = vi.fn<BriefingSummarizer>().mockResolvedValue(answer);
    const generate = createBriefingGenerator({ summarize, maxCacheEntries: 1 });
    await generate("one",user,evidence); await generate("two",user,evidence); await generate("one",user,evidence);
    expect(summarize).toHaveBeenCalledTimes(3);
    summarize.mockRejectedValueOnce(new Error("secret provider error"));
    const failure = await generate("three",user,evidence);
    expect(failure).toEqual({ briefings: [], generatedAt: null, coverage: "recent", unavailable: true });
    expect((await generate("three",user,evidence)).unavailable).toBeUndefined();
    expect((await generate("empty",user,[])).briefings).toEqual([]);
  });
  it("reserves evidence space for confirmed effects and multiple goal conversations", () => {
    const threads: BriefingEvidence[] = Array.from({ length: 30 },(_,i) => ({
      source: { id: `thread-${i}`, kind: "thread", title: `Goal ${i}`, updatedAt: 100-i, sessionId: "s", threadId: String(i) },
      content: "Conversation context. ".repeat(300), state: "updated",
    }));
    const budgeted = budgetBriefingEvidence([...threads,
      { source: { id: "pr", kind: "pull_request", title: "Confirmed PR", updatedAt: 101, url: "https://example.com/pr/1" }, content: "Confirmed effect: PR opened", state: "updated" },
      { source: { id: "wf", kind: "workflow", title: "Pending check", updatedAt: 102, runId: "r" }, content: "Awaiting scheduled verification.", state: "in_progress" },
    ]);
    expect(budgeted.filter(item => item.source.kind === "thread").length).toBeGreaterThanOrEqual(2);
    expect(budgeted.some(item => item.source.id === "pr")).toBe(true);
    expect(budgeted.some(item => item.source.id === "wf")).toBe(true);
    expect(budgeted.reduce((sum,item) => sum+item.content.length,0)).toBeLessThanOrEqual(24_000);
  });
  it("aborts a stalled model and returns unavailable", async () => {
    let signal: AbortSignal | undefined;
    const generate = createBriefingGenerator({ timeoutMs: 5, summarize: async (_e,abort) => {
      signal = abort;
      return new Promise<string>(() => {});
    } });
    expect((await generate("org",user,evidence)).unavailable).toBe(true);
    expect(signal?.aborted).toBe(true);
  });
});

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

describe("workspace briefing evidence", () => {
  it("fences all source owners, preserves the first request and latest messages, and omits tool payloads", async () => {
    api = await bootTestApi(); const db = api.providers.db;
    for (const [id,orgId,ownerType,ownerId] of [
      ["owned","local-org","user","local-user"], ["other","local-org","user","test-member"],
      ["foreign","other-org","user","local-user"], ["team","local-org","team","team"],
    ]) {
      await db.execute(sql`INSERT INTO agent_sessions (id,org_id,user_id,owner_type,owner_id,workspace,created_at,updated_at)
        VALUES (${id},${orgId},'local-user',${ownerType},${ownerId},'w',1,1)`);
      await db.insert(sessionThreads).values({ id: `${id}-thread`, sessionId: id, title: `${id} goal`, createdAt: 1 });
      const parts = JSON.stringify([{ type: "text", text: `${id} goal evidence` }, { type: "tool_call", result: "SECRET TOOL PAYLOAD" }, { type: "thinking", text: "SECRET REASONING" }]);
      await db.execute(sql`INSERT INTO engine_entries(id,session_id,thread_id,entry_type,role,parts,created_at)
        VALUES (${id},${id},${`${id}-thread`},'message','user',${parts},1)`);
    }
    for (let i = 2; i < 12; i++) {
      await db.execute(sql`INSERT INTO engine_entries(id,session_id,thread_id,entry_type,role,content,created_at)
        VALUES (${`latest-${i}`},'owned','owned-thread','message','assistant',${`Current conclusion ${i}: ${"evidence ".repeat(250)}`},${i})`);
    }
    await db.insert(artifacts).values([
      { id: "art", token: "safe-token", ownerType: "user", ownerId: "local-user", orgId: "local-org", actorUserId: "local-user", sourceSessionId: "other", sourceThreadId: "other-thread", sourceMemoryPath: "owned-art", content: "Owned artifact evidence", title: "Artifact", createdAt: 12, updatedAt: 12 },
      { id: "private", token: "private-token", ownerType: "user", ownerId: "test-member", orgId: "local-org", actorUserId: "test-member", sourceMemoryPath: "private-art", content: "PRIVATE ARTIFACT", title: "Private", createdAt: 12, updatedAt: 12 },
    ]);
    await db.insert(agentSessions).values({ id: "deleted", orgId: "local-org", userId: "local-user", ownerType: "user", ownerId: "local-user", status: "deleted", workspace: "w", createdAt: 1, updatedAt: 1 });
    await db.insert(sessionThreads).values({ id: "deleted-thread", sessionId: "deleted", createdAt: 1 });
    await db.execute(sql`INSERT INTO engine_entries(id,session_id,thread_id,entry_type,role,content,created_at)
      VALUES ('deleted-message','deleted','deleted-thread','message','user','DELETED CONTENT',999)`);
    const toolOnly = JSON.stringify([{ type: "tool_call", toolName: "bash", result: "SECRET TOOL PAYLOAD" }]);
    await db.execute(sql`INSERT INTO engine_entries(id,session_id,thread_id,entry_type,role,parts,created_at)
      VALUES ('tool-only','owned','owned-thread','message','assistant',${toolOnly},999)`);
    const sources = await collectWorkspaceBriefingSources(db,"local-org",user);
    const thread = sources.find(item => item.source.kind === "thread");
    expect(thread?.content).toContain("owned goal evidence");
    expect(thread?.content).toContain("Current conclusion 11");
    expect(thread?.source.updatedAt).toBe(11);
    expect(sources.find(item => item.source.kind === "artifact")?.source).toEqual({ id: "artifact:art", token: "safe-token", kind: "artifact", title: "Artifact", updatedAt: 12 });
    expect(JSON.stringify(sources)).not.toMatch(/DELETED|SECRET|PRIVATE|other goal|foreign goal|team goal|private-token|other-thread/);
    expect(sources.reduce((n,item) => n+item.content.length,0)).toBeLessThanOrEqual(24_000);
    const team = await collectWorkspaceBriefingSources(db,"local-org",{ type: "team", id: "team" });
    expect(team.map(item => item.source.sessionId)).toEqual(["team"]);
  });
  it("links a Slack-triggered run to its Slack thread and a same-workspace origin to its thread", async () => {
    api = await bootTestApi(); const db = api.providers.db;
    const definition = { version: "dag/v1", nodes: [{ id: "finish", type: "stop" }], edges: [] };
    await db.insert(agentSessions).values([
      { id: "mine", userId: "local-user", orgId: "local-org", workspace: "/", ownerType: "user", ownerId: "local-user", createdAt: 1, updatedAt: 1 },
      { id: "theirs", userId: "other-user", orgId: "local-org", workspace: "/", ownerType: "user", ownerId: "other-user", createdAt: 1, updatedAt: 1 },
    ]);
    await db.insert(sessionThreads).values([{ id: "my-thread", sessionId: "mine", createdAt: 1 }, { id: "their-thread", sessionId: "theirs", createdAt: 1 }]);
    await db.insert(workflowDefinitions).values({ id: "wf", orgId: "local-org", ownerType: "user", ownerId: "local-user", name: "Intake", definition, createdAt: 1, updatedAt: 1 });
    const slackEvent = { type: "event", data: { key: "slack.app_mention", payload: { channel: "C1", ts: "1700000000.000200", thread_ts: "1700000000.000100" } } };
    await db.insert(workflowRuns).values([
      { id: "slack-run", workflowId: "wf", definitionVersionId: "v", definition, params: { input: slackEvent, origin: { assistantSessionId: "mine", threadId: "my-thread" } }, ownerType: "user", ownerId: "local-user", status: "settled", outcome: "completed", createdAt: 1, updatedAt: 10 },
    ]);
    await db.insert(workflowCheckpoints).values({ runId: "slack-run", nodeId: "finish", status: "completed", attempt: 1, result: { output: "Triaged." }, createdAt: 9 });
    const run = (await collectWorkspaceBriefingSources(db,"local-org",user)).find(item => item.source.runId === "slack-run");
    expect(run?.source).toMatchObject({ sessionId: "mine", threadId: "my-thread", originUrl: "https://slack.com/archives/C1/p1700000000000100" });

    // A run whose origin is another person's thread never links to it.
    await db.execute(sql`UPDATE workflow_runs SET params=jsonb_set(params,'{origin}','{"assistantSessionId":"theirs","threadId":"their-thread"}') WHERE id='slack-run'`);
    const foreign = (await collectWorkspaceBriefingSources(db,"local-org",user)).find(item => item.source.runId === "slack-run");
    expect(foreign?.source.sessionId).toBeUndefined();
    expect(foreign?.source.threadId).toBeUndefined();
  });
  it("uses scoped narrative workflow checkpoints, current approval prompts and failed findings", async () => {
    api = await bootTestApi(); const db = api.providers.db;
    const definition = { version: "dag/v1", nodes: [{ id: "finish", type: "stop" }, { id: "review", type: "approval", prompt: "Approve concurrent verification for TKAI-559" }], edges: [] };
    await db.insert(workflowDefinitions).values([
      { id: "wf", orgId: "local-org", ownerType: "user", ownerId: "local-user", name: "TKAI-559", definition, createdAt: 1, updatedAt: 1 },
      { id: "failed-wf", orgId: "local-org", ownerType: "user", ownerId: "local-user", name: "Failed verification", definition, createdAt: 1, updatedAt: 1 },
      { id: "timer-wf", orgId: "local-org", ownerType: "user", ownerId: "local-user", name: "Delayed verification", definition, createdAt: 1, updatedAt: 1 },
      { id: "foreign-wf", orgId: "other-org", ownerType: "user", ownerId: "local-user", name: "Foreign", definition, createdAt: 1, updatedAt: 1 },
    ]);
    await db.insert(workflowRuns).values([
      { id: "run", workflowId: "wf", definitionVersionId: "v", definition, params: {}, ownerType: "user", ownerId: "local-user", status: "parked", waitingOn: [{ kind: "signal", nodeId: "review", signalType: "approval:review" }], createdAt: 1, updatedAt: 10 },
      { id: "failed", workflowId: "failed-wf", definitionVersionId: "v", definition, params: {}, ownerType: "user", ownerId: "local-user", status: "settled", outcome: "failed", createdAt: 1, updatedAt: 11 },
      { id: "foreign-run", workflowId: "foreign-wf", definitionVersionId: "v", definition, params: {}, ownerType: "user", ownerId: "local-user", status: "settled", createdAt: 1, updatedAt: 12 },
    ]);
    await db.insert(workflowCheckpoints).values([
      { runId: "run", nodeId: "finish", status: "completed", attempt: 1, result: { output: "Sequential checks passed; concurrency still unverified." }, createdAt: 9 },
      { runId: "failed", nodeId: "finish", status: "failed", attempt: 1, error: "Concurrent deliveries duplicated a task.", createdAt: 11 },
      { runId: "foreign-run", nodeId: "finish", status: "completed", attempt: 1, result: { output: "PRIVATE OUTPUT" }, createdAt: 12 },
    ]);
    await db.insert(workflowRuns).values({ id: "timer", workflowId: "timer-wf", definitionVersionId: "v", definition, params: {}, ownerType: "user", ownerId: "local-user", status: "parked", waitingOn: [{ kind: "timer", nodeId: "delay", wakeAt: 10000 }], createdAt: 1, updatedAt: 13 });
    const sources = await collectWorkspaceBriefingSources(db,"local-org",user);
    expect(sources).toHaveLength(3);
    expect(sources.find(item => item.source.runId === "timer")).toMatchObject({ state: "in_progress", content: expect.stringContaining("10000") });
    expect(sources.find(item => item.source.runId === "run")).toMatchObject({ state: "needs_attention", content: expect.stringContaining("Approve concurrent verification") });
    expect(sources.find(item => item.source.runId === "run")?.content).toContain("Sequential checks passed");
    expect(sources.find(item => item.source.runId === "failed")).toMatchObject({ state: "needs_attention", content: "Concurrent deliveries duplicated a task." });
    expect(JSON.stringify(sources)).not.toContain("PRIVATE OUTPUT");
    await db.execute(sql`UPDATE workflow_runs SET status='settled',outcome='completed' WHERE id='run'`);
    const settled = (await collectWorkspaceBriefingSources(db,"local-org",user)).find(item => item.source.runId === "run");
    expect(settled?.state).toBe("updated");
    expect(settled?.content).not.toContain("Pending approval");
    await db.insert(workflowRuns).values({ id: "retry-success", workflowId: "failed-wf", definitionVersionId: "v", definition, params: {}, ownerType: "user", ownerId: "local-user", status: "settled", outcome: "completed", createdAt: 20, updatedAt: 21 });
    await db.insert(workflowCheckpoints).values({ runId: "retry-success", nodeId: "finish", status: "completed", attempt: 1, result: { output: "Concurrent verification passed." }, createdAt: 21 });
    const afterRetry = await collectWorkspaceBriefingSources(db, "local-org", user);
    expect(afterRetry.find(item => item.source.runId === "failed")).toBeUndefined();
    expect(afterRetry.find(item => item.source.runId === "retry-success")).toMatchObject({ state: "updated", content: "Concurrent verification passed." });
    // A Thread step is stored as `orchestrator`; its reply is run evidence.
    const threadStep = { version: "dag/v1", nodes: [{ id: "trigger", type: "trigger" }, { id: "report", type: "orchestrator", prompt: "Report." }], edges: [{ from: "trigger", to: "report" }] };
    await db.insert(workflowRuns).values({ id: "thread-step", workflowId: "wf", definitionVersionId: "v2", definition: threadStep, params: {}, ownerType: "user", ownerId: "local-user", status: "settled", outcome: "completed", createdAt: 30, updatedAt: 31 });
    await db.insert(workflowCheckpoints).values({ runId: "thread-step", nodeId: "report", status: "completed", attempt: 1, result: { response: "Thread step reported the result." }, createdAt: 31 });
    expect((await collectWorkspaceBriefingSources(db, "local-org", user)).find(item => item.source.runId === "thread-step")?.content).toContain("Thread step reported the result.");
    expect(await collectWorkspaceBriefingSources(db,"local-org",{ type: "team", id: "other" })).toEqual([]);
  });
});
