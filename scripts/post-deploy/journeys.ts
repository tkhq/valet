/**
 * The post-deploy journeys: real user paths driven over the public API
 * against a deployed instance. Each journey creates throwaway resources,
 * registers their cleanup, and records evidence. The runner
 * (`scripts/post-deploy.ts`) runs the cleanups whether the journey passed or
 * not, and reports any that did not finish.
 *
 * Runbook: docs/testing/post-deploy-journeys.md
 */
import type {
  ActionDescribeResponse,
  ActionInvokeResponse,
  ActionSearchResponse,
  CreateEventSubscriptionRequest,
  CreateEventSubscriptionResponse,
  CreateThreadResponse,
  EventDeliveryWire,
  EventLogResponse,
  GetEventResponse,
  GetWorkflowRunResponse,
  ListDecisionsResponse,
  ListMessagesResponse,
  ListPluginsResponse,
  ListPolicyOverridesResponse,
  ListSubscriptionDeliveriesResponse,
  Message,
  PutPolicyOverrideRequest,
  ResolveWorkflowApprovalRequest,
  StartWorkflowRunResponse,
  WorkflowDefinitionSummary,
  WorkflowRunCheckpoint,
} from "../../packages/api/src/wire/types.js";
import { type ApiClient, GitHubClient, HttpError } from "./client.js";
import { pollUntil, unclearErrorReason } from "./lib.js";

/** Every resource a journey creates carries this name prefix, so `--sweep` can find leftovers. */
export const NAME_PREFIX = "post-deploy journey";

export interface JourneyEnv {
  api: ApiClient;
  me: { id: string; orgId: string };
  /** Short id for this run, in every resource name. */
  runId: string;
  env: NodeJS.ProcessEnv;
}

export interface JourneyContext {
  /** Record one fact for the report. */
  note(key: string, value: string): void;
  /** Register a cleanup. Cleanups run last-registered first. */
  cleanup(label: string, fn: () => Promise<void>): void;
}

export interface Journey {
  id: string;
  title: string;
  run(env: JourneyEnv, ctx: JourneyContext): Promise<void>;
}

/** The journey cannot run here (missing config). Not a deploy failure. */
export class Skip extends Error {}

/** An expectation the deployment did not meet. */
export class Check extends Error {}

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Check(message);
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

// ── Workflows ───────────────────────────────────────────────────────────────

function runUrl(runId: string): string {
  return `/api/workflows/runs/${encodeURIComponent(runId)}`;
}

function checkpoint(detail: GetWorkflowRunResponse, nodeId: string): WorkflowRunCheckpoint | undefined {
  return detail.checkpoints.find((c) => c.nodeId === nodeId);
}

/** One line per step: `x=completed y=intent`. */
function stepStates(detail: GetWorkflowRunResponse): string {
  return detail.checkpoints.map((c) => `${c.nodeId}=${c.status}`).join(" ") || "(no steps recorded)";
}

async function createWorkflow(env: JourneyEnv, ctx: JourneyContext, label: string, definition: unknown): Promise<WorkflowDefinitionSummary> {
  const wf = await env.api.post<WorkflowDefinitionSummary>("/api/workflows", { name: `${NAME_PREFIX} ${env.runId} ${label}`, definition });
  ctx.cleanup(`delete workflow ${wf.id}`, () => deleteWorkflow(env.api, wf.id));
  return wf;
}

/** Cancel the run when it has not settled, and wait for it to settle. */
async function settleRun(api: ApiClient, runId: string): Promise<void> {
  const detail = await api.get<GetWorkflowRunResponse>(runUrl(runId));
  if (detail.run.status === "settled") return;
  await api.post(`${runUrl(runId)}/cancel`);
  await pollUntil("the cancelled run to settle", () => api.get<GetWorkflowRunResponse>(runUrl(runId)), (d) => d.run.status === "settled", {
    timeoutMs: 60 * SECOND,
    intervalMs: SECOND,
  });
}

/** Delete a workflow. The route refuses (409) while a run has not settled, so retry for a short time. */
export async function deleteWorkflow(api: ApiClient, workflowId: string): Promise<void> {
  await pollUntil(
    `workflow ${workflowId} to delete`,
    async () => {
      try {
        await api.delete(`/api/workflows/${encodeURIComponent(workflowId)}`);
        return true;
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return true;
        if (err instanceof HttpError && err.status === 409) return false;
        throw err;
      }
    },
    (deleted) => deleted,
    { timeoutMs: 60 * SECOND, intervalMs: 2 * SECOND },
  );
}

async function startRun(env: JourneyEnv, ctx: JourneyContext, workflowId: string): Promise<string> {
  const { runId } = await env.api.post<StartWorkflowRunResponse>(`/api/workflows/${encodeURIComponent(workflowId)}/runs`, {});
  ctx.note("run", runId);
  ctx.cleanup(`settle run ${runId}`, () => settleRun(env.api, runId));
  return runId;
}

/**
 * A run with two independent branches: one waits on a 10-minute timer, the
 * other is two `set` steps in sequence. The second step must run while the
 * first branch waits. The regression this catches parked the whole run as
 * soon as one step waited, so `y` never ran (fixed in #949).
 */
export const workflowBranches: Journey = {
  id: "workflow-branches",
  title: "A workflow branch that is ready finishes while a parallel branch waits on a timer",
  async run(env, ctx) {
    const wf = await createWorkflow(env, ctx, "parallel branches", {
      version: "dag/v1",
      nodes: [
        { id: "start", type: "trigger" },
        { id: "hold", type: "wait", mode: "duration", duration: "10m" },
        { id: "x", type: "set", values: { a: 1 } },
        { id: "y", type: "set", values: { b: "{{nodes.x.result.a}}" } },
        { id: "done", type: "stop", outcome: "success" },
      ],
      edges: [
        { from: "start", to: "hold" },
        { from: "start", to: "x" },
        { from: "x", to: "y" },
        { from: "hold", to: "done" },
        { from: "y", to: "done" },
      ],
    });
    ctx.note("workflow", wf.id);
    const runId = await startRun(env, ctx, wf.id);

    const detail = await pollUntil(
      "the run to park on its timer",
      () => env.api.get<GetWorkflowRunResponse>(runUrl(runId)),
      (d) => d.run.status === "parked" || d.run.status === "settled",
      { timeoutMs: 60 * SECOND, intervalMs: 500 },
    );
    ctx.note("run status", `${detail.run.status}${detail.run.outcome ? ` (${detail.run.outcome})` : ""}`);
    ctx.note("steps", stepStates(detail));
    expect(detail.run.status === "parked", `The run ${detail.run.status} instead of parking on the timer. Steps: ${stepStates(detail)}.`);
    const x = checkpoint(detail, "x");
    const y = checkpoint(detail, "y");
    expect(x?.status === "completed", `Step x did not complete while hold waited. Steps: ${stepStates(detail)}.`);
    expect(y?.status === "completed", `Step y did not run while hold waited: the run parked the ready branch. Steps: ${stepStates(detail)}.`);
    const timer = (detail.run.waitingOn ?? []).find((w) => w.kind === "timer" && w.nodeId === "hold");
    expect(timer !== undefined, `The run is not waiting on the hold timer. waitingOn: ${JSON.stringify(detail.run.waitingOn)}.`);
    expect(checkpoint(detail, "done") === undefined, "Step done ran before the timer fired.");
    ctx.note("ready branch finished", `${y.createdAt - detail.run.createdAt} ms after the run started`);
    ctx.note("waiting on", `timer hold, wakes ${new Date(timer.wakeAt ?? 0).toISOString()}`);
  },
};

const GATED_ACTION = { service: "workflows", action: "get_workflow" } as const;
const GATED_ACTION_ID = `${GATED_ACTION.service}.${GATED_ACTION.action}`;

function gatedDefinition(workflowId: string) {
  return {
    version: "dag/v1",
    nodes: [
      { id: "start", type: "trigger" },
      { id: "gated", type: "tool", service: GATED_ACTION.service, action: GATED_ACTION.action, params: { workflow_id: workflowId }, approvalTimeout: "30m" },
      { id: "after", type: "set", values: { ok: true } },
    ],
    edges: [
      { from: "start", to: "gated" },
      { from: "gated", to: "after" },
    ],
  };
}

/**
 * A tool step whose saved permission says "ask first". The step must park
 * with an approval card, and "Approve once" must let the run finish. The
 * permission is a personal override scoped to this one workflow id, so the
 * account's other calls are not affected; the cleanup deletes it.
 */
export const workflowApproval: Journey = {
  id: "workflow-approval",
  title: "A tool step that needs approval shows its card, and Approve once lets the run finish",
  async run(env, ctx) {
    const { overrides } = await env.api.get<ListPolicyOverridesResponse>("/api/me/policy-overrides");
    if (overrides.some((o) => o.actionId === GATED_ACTION_ID)) {
      throw new Skip(
        `The account already has a saved permission for ${GATED_ACTION_ID}, and this journey would replace it. Remove that permission, or run the journeys with a dedicated test account.`,
      );
    }

    // The step reads its own workflow, so the definition needs the id the create returns.
    const wf = await createWorkflow(env, ctx, "approval step", gatedDefinition("pending"));
    await env.api.put(`/api/workflows/${encodeURIComponent(wf.id)}`, { definition: gatedDefinition(wf.id) });
    ctx.note("workflow", wf.id);

    const override: PutPolicyOverrideRequest = {
      actionId: GATED_ACTION_ID,
      mode: "require_approval",
      paramMatchers: [{ path: "workflow_id", op: "eq", value: wf.id }],
    };
    await env.api.put("/api/me/policy-overrides", override);
    ctx.cleanup(`delete the saved permission for ${GATED_ACTION_ID}`, async () => {
      try {
        await env.api.delete("/api/me/policy-overrides", { actionId: GATED_ACTION_ID });
      } catch (err) {
        if (!(err instanceof HttpError && err.status === 404)) throw err;
      }
    });

    const runId = await startRun(env, ctx, wf.id);
    const started = Date.now();
    const parked = await pollUntil(
      "the approval card",
      () => env.api.get<GetWorkflowRunResponse>(runUrl(runId)),
      (d) => d.pendingGates.some((g) => g.nodeId === "gated") || d.run.status === "settled" || checkpoint(d, "gated")?.status === "completed",
      { timeoutMs: 60 * SECOND, intervalMs: 500 },
    );
    const gate = parked.pendingGates.find((g) => g.nodeId === "gated");
    expect(
      gate !== undefined,
      `The step did not ask for approval: the saved permission did not apply. Run ${parked.run.status}${parked.run.outcome ? ` (${parked.run.outcome})` : ""}; steps: ${stepStates(parked)}.`,
    );
    expect(gate.kind === "policy_gate", `The card is a ${gate.kind} card, not a tool approval card.`);
    expect(gate.gateId !== undefined, "The approval card has no gate id, so Approve once cannot address it.");
    ctx.note("approval card", `${gate.kind} ${gate.gateId}, shown ${Date.now() - started} ms after the run started`);

    const approve: ResolveWorkflowApprovalRequest = { approved: true, scope: "once", gateId: gate.gateId };
    const approvedAt = Date.now();
    await env.api.post(`${runUrl(runId)}/approvals/gated`, approve);

    const settled = await pollUntil(
      "the approved run to finish",
      () => env.api.get<GetWorkflowRunResponse>(runUrl(runId)),
      (d) => d.run.status === "settled",
      { timeoutMs: 60 * SECOND, intervalMs: 500 },
    );
    ctx.note("steps", stepStates(settled));
    expect(settled.run.outcome === "completed", `The run ended ${settled.run.outcome ?? "with no outcome"} after Approve once. Steps: ${stepStates(settled)}.`);
    expect(checkpoint(settled, "gated")?.status === "completed", `The approved step did not complete. Steps: ${stepStates(settled)}.`);
    expect(checkpoint(settled, "after")?.status === "completed", `The step after the approval did not run. Steps: ${stepStates(settled)}.`);
    ctx.note("finished", `${Date.now() - approvedAt} ms after Approve once`);
  },
};

// ── Integration call ────────────────────────────────────────────────────────

/**
 * One read-only integration call through the tool broker, with the test
 * account's own connection. It passes when the call completes, or when it
 * fails with an error that names the integration (a disconnected or expired
 * account is not a deploy failure, but an unreadable error is).
 */
export const mcpCall: Journey = {
  id: "mcp-call",
  title: "An MCP integration call with the test account's connection succeeds or names its error",
  async run(env, ctx) {
    const toolId = env.env.VALET_JOURNEY_MCP_TOOL || "linear.get_workspace";
    let params: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(env.env.VALET_JOURNEY_MCP_PARAMS || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      params = Object.fromEntries(Object.entries(parsed));
    } catch {
      throw new Skip("VALET_JOURNEY_MCP_PARAMS is not a JSON object. Set it to the tool's params, for example {}.");
    }
    const service = toolId.split(".")[0] ?? toolId;
    ctx.note("tool", toolId);

    const { plugins } = await env.api.get<ListPluginsResponse>("/api/plugins");
    const plugin = plugins.find((p) => p.services.some((s) => s.service === service));
    const names = [...new Set([service, plugin?.displayName ?? "", plugin?.name ?? ""].filter(Boolean))];

    const namedError = (text: string, where: string) => {
      const unclear = unclearErrorReason(text, names);
      expect(unclear === null, `The ${where} error is not clear: ${unclear}. Error: ${text.slice(0, 300)}`);
      ctx.note("outcome", `named error (${where}): ${text.slice(0, 200)}`);
    };

    const search = await env.api.get<ActionSearchResponse>(`/api/actions?service=${encodeURIComponent(service)}&workspace=user&limit=1`);
    const unavailable = search.unavailable?.find((u) => u.service === service);
    if (unavailable) return namedError(unavailable.reason, "tool list");

    let described: ActionDescribeResponse;
    try {
      described = await env.api.get<ActionDescribeResponse>(
        `/api/actions/${encodeURIComponent(toolId)}?workspace=user&params=${encodeURIComponent(JSON.stringify(params))}`,
      );
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return namedError(err.errorText, "describe");
      throw err;
    }
    // A post-deploy check must not write to the integration: only read-only (low risk) tools run.
    if (described.risk_level !== "low") {
      throw new Skip(`${toolId} is ${described.risk_level} risk. Set VALET_JOURNEY_MCP_TOOL to a read-only (low risk) tool.`);
    }
    expect(described.policy === "allow", `${toolId} resolves to ${described.policy}. Set VALET_JOURNEY_MCP_TOOL to a read-only tool that the account may call without approval.`);

    const started = Date.now();
    let result: ActionInvokeResponse;
    try {
      result = await env.api.post<ActionInvokeResponse>(`/api/actions/${encodeURIComponent(toolId)}/invoke`, { params, workspace: "user" });
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return namedError(err.errorText, "call");
      throw err;
    }
    ctx.note("latency", `${Date.now() - started} ms`);
    if (result.status === "failed") return namedError(result.error, "call");
    expect(result.status === "completed", `The call returned ${result.status}: ${"next_step" in result ? result.next_step : ""}`);
    const keys = result.result && typeof result.result === "object" ? Object.keys(result.result).slice(0, 8).join(", ") : typeof result.result;
    ctx.note("outcome", `completed; result fields: ${keys}`);
  },
};

// ── Event delivery ──────────────────────────────────────────────────────────

const DELIVERY_PROMPT =
  "This delivery is an automated post-deploy check. Do not call any tools. Reply with one line: post-deploy check received.";

function eventsLogUrl(me: JourneyEnv["me"], problems: boolean): string {
  return `/api/events/log?ownerType=user&ownerId=${encodeURIComponent(me.id)}&limit=50${problems ? "&problems=1" : ""}`;
}

async function archiveThread(api: ApiClient, threadId: string): Promise<void> {
  // The route refuses (409) while a turn runs in the thread.
  await pollUntil(
    `thread ${threadId} to archive`,
    async () => {
      try {
        await api.patch(`/api/threads/${encodeURIComponent(threadId)}`, { archived: true });
        return true;
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return true;
        if (err instanceof HttpError && err.status === 409) return false;
        throw err;
      }
    },
    (done) => done,
    { timeoutMs: 2 * MINUTE, intervalMs: 3 * SECOND },
  );
}

async function createRule(env: JourneyEnv, ctx: JourneyContext, body: CreateEventSubscriptionRequest): Promise<string> {
  const rule = await env.api.post<CreateEventSubscriptionResponse>("/api/event-subscriptions", body);
  ctx.cleanup(`delete event rule ${rule.id}`, async () => {
    try {
      await env.api.delete(`/api/event-subscriptions/${encodeURIComponent(rule.id)}`);
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) throw err;
    }
  });
  return rule.id;
}

/** The rule's delivery of the event whose push payload names `ref`. Reads each new event once. */
function deliveryFinder(api: ApiClient, ref: string) {
  const refByEvent = new Map<string, string | null>();
  return async (ruleId: string): Promise<(EventDeliveryWire & { eventId: string }) | undefined> => {
    const { deliveries } = await api.get<ListSubscriptionDeliveriesResponse>(`/api/event-subscriptions/${encodeURIComponent(ruleId)}/deliveries?limit=20`);
    for (const d of deliveries) {
      if (!refByEvent.has(d.event.id)) {
        const { event } = await api.get<GetEventResponse>(`/api/events/${encodeURIComponent(d.event.id)}`);
        const payload = event.payload;
        const eventRef = payload && typeof payload === "object" && "ref" in payload && typeof payload.ref === "string" ? payload.ref : null;
        refByEvent.set(d.event.id, eventRef);
      }
      if (refByEvent.get(d.event.id) === ref) return { ...d, eventId: d.event.id };
    }
    return undefined;
  };
}

function lastAssistantState(messages: Message[]): Message | undefined {
  return [...messages].reverse().find((m) => m.role === "assistant" && m.stopReason !== undefined);
}

/**
 * A real event delivery. The journey creates two rules on `github.push`
 * for one repo and sender, then creates a throwaway branch, which makes
 * GitHub send a push event:
 *
 * - Rule A delivers to the assistant in its own thread. The delivery must
 *   reach `delivered`, and the assistant turn must end normally, with no
 *   question parked and no failed turn.
 * - Rule B pins a thread that the journey archived first, so its delivery
 *   goes dead. The event must show under the events Log Problems filter,
 *   with the reason.
 *
 * Needs a GitHub token that may create and delete branches in the repo, and
 * a repo where the instance's GitHub App receives events.
 */
export const eventDelivery: Journey = {
  id: "event-delivery",
  title: "An event delivery to the assistant runs and completes, and a dead delivery shows under Problems",
  async run(env, ctx) {
    const repo = env.env.VALET_JOURNEY_GITHUB_REPO;
    const token = env.env.VALET_JOURNEY_GITHUB_TOKEN || env.env.GITHUB_TOKEN || env.env.GH_TOKEN;
    if (!repo || !token) {
      throw new Skip("Set VALET_JOURNEY_GITHUB_REPO (owner/name) and a GitHub token (VALET_JOURNEY_GITHUB_TOKEN or GITHUB_TOKEN) that may create branches in it.");
    }
    const github = new GitHubClient(token);
    let sender = env.env.VALET_JOURNEY_GITHUB_SENDER;
    if (!sender) {
      try {
        sender = (await github.get<{ login: string }>("/user")).login;
      } catch {
        // An Actions GITHUB_TOKEN cannot read /user; its pushes come from this bot.
        if (env.env.GITHUB_ACTIONS === "true") sender = "github-actions[bot]";
        else throw new Skip("Set VALET_JOURNEY_GITHUB_SENDER to the GitHub login that the token pushes as.");
      }
    }
    const branch = `valet-post-deploy/${env.runId}`;
    const ref = `refs/heads/${branch}`;
    ctx.note("push", `${repo} ${ref} as ${sender}`);

    // Cleanups run last-registered first. The rules go first, then the
    // branch: deleting the branch sends one more push event, which must find
    // no rule. The threads go last, because an archive waits for a running turn.
    const threads: string[] = [];
    ctx.cleanup("archive the journey's threads", async () => {
      for (const id of threads) await archiveThread(env.api, id);
    });
    let branchCreated = false;
    ctx.cleanup(`delete branch ${repo}:${branch}`, async () => {
      if (!branchCreated) return;
      try {
        await github.delete(`/repos/${repo}/git/refs/heads/${branch}`);
      } catch (err) {
        if (!(err instanceof HttpError && (err.status === 404 || err.status === 422))) throw err;
      }
    });

    // Rule B's thread: pinned, then archived, so the delivery cannot land.
    const pinned = await env.api.post<CreateThreadResponse>("/api/threads?workspace=user", { title: `${NAME_PREFIX} ${env.runId} archived target` });
    threads.push(pinned.id);

    const filters = [
      { field: "repo", op: "eq" as const, value: repo },
      { field: "sender", op: "eq" as const, value: sender },
    ];
    const ruleA = await createRule(env, ctx, {
      name: `${NAME_PREFIX} ${env.runId} delivery`,
      eventKeys: ["github.push"],
      filters,
      target: { kind: "assistant", assistant: "user", systemPrompt: DELIVERY_PROMPT, thread: { mode: "own" } },
      enabled: true,
      allowCollision: true,
    });
    const ruleB = await createRule(env, ctx, {
      name: `${NAME_PREFIX} ${env.runId} problem`,
      eventKeys: ["github.push"],
      filters,
      target: { kind: "assistant", assistant: "user", systemPrompt: DELIVERY_PROMPT, thread: { mode: "existing", sessionId: pinned.sessionId, threadId: pinned.id } },
      enabled: true,
      allowCollision: true,
    });
    ctx.note("rules", `${ruleA} (assistant), ${ruleB} (archived thread)`);
    await env.api.patch(`/api/threads/${encodeURIComponent(pinned.id)}`, { archived: true });

    const repoInfo = await github.get<{ default_branch: string }>(`/repos/${repo}`);
    const head = await github.get<{ commit: { sha: string } }>(`/repos/${repo}/branches/${encodeURIComponent(repoInfo.default_branch)}`);
    await github.post(`/repos/${repo}/git/refs`, { ref, sha: head.commit.sha });
    branchCreated = true;
    const pushedAt = Date.now();

    // Delivery A: delivered to the assistant.
    const find = deliveryFinder(env.api, ref);
    const delivered = await pollUntil(
      "the push to reach rule A's assistant",
      () => find(ruleA),
      (d) => d !== undefined && d.status !== "pending" && d.status !== "failed",
      { timeoutMs: 5 * MINUTE, intervalMs: 3 * SECOND },
    );
    expect(delivered !== undefined, "No delivery arrived.");
    ctx.note("event", delivered.eventId);
    expect(delivered.status === "delivered", `Rule A's delivery is ${delivered.status}: ${delivered.lastError ?? "no reason recorded"}.`);
    expect(delivered.thread !== undefined, "The delivery names no assistant thread.");
    const threadId = delivered.thread.threadId;
    threads.push(threadId);
    ctx.note("delivered", `${(delivered.deliveredAt ?? Date.now()) - pushedAt} ms after the push, to thread ${threadId}`);

    // The assistant turn: it must end normally, not park or fail.
    const turn = await pollUntil(
      "the assistant turn to end",
      async () => {
        const [{ messages }, { gates }] = await Promise.all([
          env.api.get<ListMessagesResponse>(`/api/threads/${encodeURIComponent(threadId)}/messages`),
          env.api.get<ListDecisionsResponse>(`/api/threads/${encodeURIComponent(threadId)}/decisions`),
        ]);
        return { last: lastAssistantState(messages), gates: gates.filter((g) => g.status === "pending") };
      },
      (s) => s.gates.length > 0 || s.last !== undefined,
      { timeoutMs: 5 * MINUTE, intervalMs: 3 * SECOND },
    );
    expect(turn.gates.length === 0, `The delivered turn parked on a ${turn.gates.map((g) => g.type).join(", ")} gate.`);
    expect(turn.last !== undefined, "No assistant reply.");
    expect(
      turn.last.stopReason === "end_turn" && turn.last.completed === true,
      `The assistant turn ended with ${turn.last.stopReason}: ${turn.last.errorMessage ?? "no error text"}.`,
    );
    ctx.note("turn", `ended normally ${turn.last.createdAt - pushedAt} ms after the push: "${turn.last.content.replace(/\s+/g, " ").slice(0, 80)}"`);
    const { deliveries } = await env.api.get<GetEventResponse>(`/api/events/${encodeURIComponent(delivered.eventId)}`);
    expect(!deliveries.some((d) => d.subscriptionId === ruleA && d.turnFailed), "The event marks rule A's turn as failed.");

    // Delivery B: dead, and listed under Problems with its reason.
    const dead = await pollUntil(
      "rule B's delivery to go dead",
      () => find(ruleB),
      (d) => d !== undefined && (d.status === "dead" || d.status === "delivered"),
      { timeoutMs: 2 * MINUTE, intervalMs: 3 * SECOND },
    );
    expect(dead?.status === "dead", `Rule B's delivery is ${dead?.status ?? "missing"}, but its thread is archived.`);
    expect(Boolean(dead.lastError), "The dead delivery records no reason.");
    const problems = await env.api.get<EventLogResponse>(eventsLogUrl(env.me, true));
    const row = problems.items.find((i) => i.kind === "event" && i.id === delivered.eventId);
    expect(row !== undefined, `The event is not under the Log's Problems filter (${problems.items.length} rows).`);
    expect(row.status === "failed", `The Problems row says ${row.status}, not failed.`);
    expect(Boolean(row.detail), "The Problems row shows no reason.");
    ctx.note("problems row", `${row.status}: ${row.detail}`);
  },
};

export const JOURNEYS: Journey[] = [eventDelivery, workflowBranches, workflowApproval, mcpCall];
