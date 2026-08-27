/**
 * Action policies + audit — exit-criteria e2e (action-policies plan Task 6;
 * see `docs/specs/2026-07-16-action-policies-audit-design.md`'s "Exit
 * criteria" section, which this test walks almost verbatim).
 *
 * Fixture-first, per the coordinator's T6 scope: a real `createApp` +
 * real engine turns, but every LLM call is intercepted by
 * `registerFauxProvider` (no network, no real API key) — same pattern as
 * `routes/llm-providers.e2e.test.ts` and this directory's own
 * `plugins.e2e.test.ts`. Every step's persisted `action_invocations` row is
 * read back via `GET /api/org/action-log` and asserted on `resolvedMode`/
 * `baseMode`/`matchedPolicyId`/`matchedGrantId`/`matchedOverrideId`/`status`
 * — the audit-provenance half of the brief's "every step's audit row
 * provenance-checked".
 *
 * A fixture `ValetPlugin` ("widgets"/"danger" services) stands in for real
 * plugins so the test controls risk levels precisely:
 *   - `widgets.ping`   — low risk    (risk default: allow)
 *   - `widgets.nuke`   — critical risk (risk default: require_approval)
 *   - `widgets.deploy` — medium risk (risk default: allow; gated later by an
 *                        action-scope org policy with a param matcher)
 *   - `danger.wipe`    — low risk    (gated later by a service-scope deny —
 *                        the spec's "kill switch is a deny policy at
 *                        service scope")
 *
 * Steps (spec exit criteria, in order):
 *   a. Defaults intact — no config: a critical-risk action gates, a
 *      low-risk one doesn't.
 *   b. Admin sets a service to deny (kill switch) — the next call to that
 *      service refuses; the denied row carries the matched policy.
 *   c. Admin sets a specific action to require_approval with a param
 *      matcher — matching params gate, non-matching don't.
 *   d. Approving with "approve for this session" — the action then runs
 *      grant-clean for the rest of the session; the grant is listed (and
 *      revocable) in My grants; revoking re-gates; re-approving then
 *      stopping the session kills the grant.
 *   e. A per-user override tightens an allow→require_approval for that
 *      user only (proven live for the acting user; proven absent for
 *      another user via the resolver preview route).
 *   f. A workflow tool node hitting require_approval with no grant fails
 *      the run with the instructive error; an upstream approval node
 *      resolved with "grant the rest of this run" lets a second run pass.
 *
 * Two former deviations this file used to work around are now FIXED and
 * pinned here instead:
 *   - Action-id conventions are unified (spec Deviations T6 #3): both the
 *     session path and the workflow path resolve the policy-facing actionId
 *     to the fully-qualified fqid (`"widgets.nuke"`), so step (f)'s
 *     workflow-run grant uses the same qualified id as everything else and
 *     `grantPolicyKey` collapses to plain `"widgets.nuke"`.
 *   - `gatedAuditId` now includes `queueItemId` (spec Deviations T6 #4), so
 *     separate turns that gate on the IDENTICAL (tool, params) pair each get
 *     their own audit row. Steps (a) and (d) deliberately reuse `{}` params
 *     across three gated `widgets.nuke` turns to pin exactly that.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import type { PluginAction, ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "./_setup.js";
import type {
  ActionLogEntryWire,
  CreateOrgPolicyResponse,
  CreateSessionResponse,
  CreateWorkflowResponse,
  GetWorkflowRunResponse,
  ListActionLogResponse,
  ListDecisionsResponse,
  ListGrantsResponse,
  PreviewOrgPolicyResponse,
  PutPolicyOverrideResponse,
  ResolveWorkflowApprovalResponse,
  StartWorkflowRunResponse,
} from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

let api: TestApi | undefined;
let workspaceRoot: string | undefined;
let faux: FauxProviderRegistration | undefined;

afterEach(async () => {
  faux?.unregister();
  faux = undefined;
  await api?.cleanup();
  api = undefined;
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  workspaceRoot = undefined;
  vi.unstubAllEnvs();
});

// ── Fixture plugin ─────────────────────────────────────────────────────────

function makePolicyFixturePlugin(): { plugin: ValetPlugin; calls: (actionId: string) => number } {
  const calls = new Map<string, number>();
  const bump = (id: string) => calls.set(id, (calls.get(id) ?? 0) + 1);

  const ping: PluginAction = {
    id: "widgets.ping",
    name: "Ping",
    description: "Low-risk fixture action.",
    riskLevel: "low",
    parameters: Type.Object({}),
    execute: async () => {
      bump("widgets.ping");
      return { success: true, data: { pinged: true } };
    },
  };
  // No param variation needed across gated calls: `gatedAuditId` includes
  // `queueItemId`, so separate turns gating on the identical (tool, params)
  // pair each mint a distinct audit row. This test pins that by reusing `{}`
  // for every gated `widgets.nuke` call (spec Deviations T6 #4, fixed).
  const nukeParams = Type.Object({ reason: Type.Optional(Type.String()) });
  const nuke: PluginAction<typeof nukeParams> = {
    id: "widgets.nuke",
    name: "Nuke",
    description: "Critical-risk fixture action.",
    riskLevel: "critical",
    parameters: nukeParams,
    execute: async () => {
      bump("widgets.nuke");
      return { success: true, data: { nuked: true } };
    },
  };
  const deployParams = Type.Object({ env: Type.String() });
  const deploy: PluginAction<typeof deployParams> = {
    id: "widgets.deploy",
    name: "Deploy",
    description: "Medium-risk fixture action, gated by a param matcher in step (c).",
    riskLevel: "medium",
    parameters: deployParams,
    execute: async (args) => {
      bump("widgets.deploy");
      return { success: true, data: { deployed: true, env: args.env } };
    },
  };
  const wipe: PluginAction = {
    id: "danger.wipe",
    name: "Wipe",
    description: "Low-risk fixture action on a separate service, killed in step (b).",
    riskLevel: "low",
    parameters: Type.Object({}),
    execute: async () => {
      bump("danger.wipe");
      return { success: true, data: { wiped: true } };
    },
  };

  const plugin: ValetPlugin = {
    name: "policy-fixture",
    version: "0.0.1",
    actions: [
      { service: "widgets", actions: [ping, nuke, deploy] },
      { service: "danger", actions: [wipe] },
    ],
  };
  return { plugin, calls: (actionId: string) => calls.get(actionId) ?? 0 };
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 10_000, intervalMs = 100): Promise<T> {
  const start = Date.now();
  let last: T;
  for (;;) {
    last = await fn();
    if (ok(last)) return last;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`poll: timed out after ${timeoutMs}ms; last value: ${JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Queue one faux LLM turn: a `call_tool` invocation followed by a plain
 * text acknowledgement (consumed once the tool call — gated or not —
 * settles and the agent loop asks the model what to say next). */
function queueCallTool(f: FauxProviderRegistration, toolId: string, params: Record<string, unknown>, summary: string) {
  f.appendResponses([
    fauxAssistantMessage([fauxToolCall("call_tool", { tool_id: toolId, params, summary }, { id: `tc-${toolId}-${Date.now()}-${Math.random()}` })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("ok"),
  ]);
}

async function postPrompt(baseUrl: string, sessionId: string, text: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ text }),
  });
  expect(res.status).toBe(202);
}

async function pendingGate(baseUrl: string, sessionId: string) {
  const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/decisions`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as ListDecisionsResponse;
  return body.gates;
}

/** `GET .../decisions` returns every gate for the session regardless of
 * status (including already-`resolved` ones from earlier steps) — filter
 * to `status === "pending"` before picking "the gate that just opened", or
 * a stale resolved gate from a previous step gets re-addressed instead. */
async function waitForGate(baseUrl: string, sessionId: string) {
  const gates = await poll(
    async () => (await pendingGate(baseUrl, sessionId)).filter((g) => g.status === "pending"),
    (g) => g.length > 0,
  );
  return gates[0];
}

async function resolveGate(baseUrl: string, sessionId: string, gateId: string, actionId: string): Promise<void> {
  // Gate ids embed the resumeKey verbatim — `stableJson`'s pretty-printed
  // params can contain newlines/quotes, so the id segment MUST be
  // percent-encoded before it goes in a URL path.
  const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/decisions/${encodeURIComponent(gateId)}/resolve`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ actionId }),
  });
  expect(res.status).toBe(200);
}

async function actionLog(baseUrl: string, filters: Record<string, string> = {}): Promise<ActionLogEntryWire[]> {
  const qs = new URLSearchParams(filters).toString();
  const res = await fetch(`${baseUrl}/api/org/action-log${qs ? `?${qs}` : ""}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as ListActionLogResponse;
  return body.entries;
}

/**
 * `action_invocations.invocationId` is a random UUID for non-gated
 * emissions (`pol:call:{randomUUID()}`), so two rows minted within the same
 * millisecond don't sort deterministically by the log's
 * `(startedAt desc, invocationId desc)` order — "the newest row" can't be
 * found by taking index 0. Snapshot the known ids for an actionId BEFORE
 * triggering it, then poll for a row whose id isn't in that snapshot.
 */
async function knownLogIds(baseUrl: string, actionId: string): Promise<Set<string>> {
  const entries = await actionLog(baseUrl);
  return new Set(entries.filter((e) => e.actionId === actionId).map((e) => e.invocationId));
}

async function waitForNewLogRow(baseUrl: string, actionId: string, before: Set<string>): Promise<ActionLogEntryWire> {
  const found = await poll(
    async () => {
      const entries = await actionLog(baseUrl);
      return entries.find((e) => e.actionId === actionId && !before.has(e.invocationId));
    },
    (row) => row !== undefined,
  );
  if (!found) throw new Error(`no new action-log row for actionId "${actionId}"`);
  return found;
}

describe("api e2e: action policies + audit exit-criteria loop (fixture-backed, no network)", () => {
  it(
    "defaults, service deny, param matcher, approve-for-session lifecycle, user override, workflow enforcement — every step audit-provenance-checked",
    async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "fixture-key");
      faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });

      const fixture = makePolicyFixturePlugin();
      api = await bootTestApi({ plugins: [fixture.plugin] });
      const { baseUrl } = api;
      workspaceRoot = mkdtempSync(join(tmpdir(), "valet-policies-e2e-"));

      // ── Session A ──────────────────────────────────────────────────────
      const createSessionARes = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ workspace: join(workspaceRoot, "sA") }),
      });
      expect(createSessionARes.status).toBe(201);
      const sessionA = ((await createSessionARes.json()) as CreateSessionResponse).id;

      // ── (a) Defaults intact: low doesn't gate, critical does ───────────
      let before = await knownLogIds(baseUrl, "widgets.ping");
      queueCallTool(faux, "widgets.ping", {}, "ping it");
      await postPrompt(baseUrl, sessionA, "call ping");
      await poll(async () => fixture.calls("widgets.ping"), (n) => n === 1);
      expect(await pendingGate(baseUrl, sessionA)).toHaveLength(0);

      const pingRow = await waitForNewLogRow(baseUrl, "widgets.ping", before);
      expect(pingRow).toMatchObject({
        resolvedMode: "allow",
        baseMode: "allow",
        status: "completed",
        matchedPolicyId: null,
        matchedGrantId: null,
        matchedOverrideId: null,
      });

      before = await knownLogIds(baseUrl, "widgets.nuke");
      queueCallTool(faux, "widgets.nuke", {}, "nuke it");
      await postPrompt(baseUrl, sessionA, "call nuke");
      const defaultGate = await waitForGate(baseUrl, sessionA);
      expect(defaultGate.actions.map((a) => a.id).sort()).toEqual(["always_allow", "approve", "approve_session", "deny"]);
      // The live gate carries WHY it opened (spec Deviations T6 #5, fixed):
      // risk default for an unconfigured critical action.
      expect(defaultGate.provenance).toMatchObject({ baseMode: "require_approval", source: "risk_default" });
      await resolveGate(baseUrl, sessionA, defaultGate.id, "deny");
      const nukeDenyRow = await waitForNewLogRow(baseUrl, "widgets.nuke", before);
      expect(fixture.calls("widgets.nuke")).toBe(0);
      expect(nukeDenyRow).toMatchObject({ resolvedMode: "require_approval", baseMode: "require_approval", status: "rejected" });

      // ── (b) Service-scope deny (kill switch) ────────────────────────────
      before = await knownLogIds(baseUrl, "danger.wipe");
      queueCallTool(faux, "danger.wipe", {}, "wipe it");
      await postPrompt(baseUrl, sessionA, "call wipe");
      await poll(async () => fixture.calls("danger.wipe"), (n) => n === 1);
      const wipeAllowRow = await waitForNewLogRow(baseUrl, "danger.wipe", before);
      expect(wipeAllowRow.resolvedMode).toBe("allow");

      const denyPolicyRes = await fetch(`${baseUrl}/api/org/policies`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ service: "danger", mode: "deny" }),
      });
      expect(denyPolicyRes.status).toBe(201);
      const denyPolicy = (await denyPolicyRes.json()) as CreateOrgPolicyResponse;

      before = await knownLogIds(baseUrl, "danger.wipe");
      queueCallTool(faux, "danger.wipe", {}, "wipe again");
      await postPrompt(baseUrl, sessionA, "call wipe again");
      const wipeDenyRow = await waitForNewLogRow(baseUrl, "danger.wipe", before);
      expect(fixture.calls("danger.wipe")).toBe(1); // never re-executed
      expect(wipeDenyRow).toMatchObject({ resolvedMode: "deny", status: "denied", matchedPolicyId: denyPolicy.id });

      // ── (c) Action-scope require_approval with a param matcher ─────────
      const matcherPolicyRes = await fetch(`${baseUrl}/api/org/policies`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({
          actionId: "widgets.deploy",
          mode: "require_approval",
          paramMatchers: [{ path: "env", op: "eq", value: "prod" }],
        }),
      });
      expect(matcherPolicyRes.status).toBe(201);
      const matcherPolicy = (await matcherPolicyRes.json()) as CreateOrgPolicyResponse;

      // Non-matching params: no gate.
      before = await knownLogIds(baseUrl, "widgets.deploy");
      queueCallTool(faux, "widgets.deploy", { env: "staging" }, "deploy staging");
      await postPrompt(baseUrl, sessionA, "deploy staging");
      const deployStagingRow = await waitForNewLogRow(baseUrl, "widgets.deploy", before);
      expect(deployStagingRow).toMatchObject({ resolvedMode: "allow", matchedPolicyId: null });

      // Matching params: gates.
      before = await knownLogIds(baseUrl, "widgets.deploy");
      queueCallTool(faux, "widgets.deploy", { env: "prod" }, "deploy PROD");
      await postPrompt(baseUrl, sessionA, "deploy prod");
      const matcherGate = await waitForGate(baseUrl, sessionA);
      expect(matcherGate.provenance).toMatchObject({ source: "org_policy", matchedPolicyId: matcherPolicy.id });
      await resolveGate(baseUrl, sessionA, matcherGate.id, "approve");
      const deployProdRow = await waitForNewLogRow(baseUrl, "widgets.deploy", before);
      expect(deployProdRow).toMatchObject({ resolvedMode: "require_approval", status: "completed", matchedPolicyId: matcherPolicy.id });
      // Session-path rows now persist params + result (spec Deviations T6
      // #6, fixed) — the Action Log's expand affordance has real data.
      expect(deployProdRow.params).toEqual({ env: "prod" });
      expect(deployProdRow.result).toBeTruthy();

      // ── (d) "Approve for this session" grant lifecycle ──────────────────
      before = await knownLogIds(baseUrl, "widgets.nuke");
      queueCallTool(faux, "widgets.nuke", {}, "nuke, approve for session");
      await postPrompt(baseUrl, sessionA, "nuke, approve for session");
      const sessionGrantGate = await waitForGate(baseUrl, sessionA);
      await resolveGate(baseUrl, sessionA, sessionGrantGate.id, "approve_session");
      await waitForNewLogRow(baseUrl, "widgets.nuke", before);
      expect(fixture.calls("widgets.nuke")).toBe(1);

      // A follow-up call to the same action in the same session runs
      // grant-clean — no gate.
      before = await knownLogIds(baseUrl, "widgets.nuke");
      queueCallTool(faux, "widgets.nuke", {}, "nuke again, should be grant-clean");
      await postPrompt(baseUrl, sessionA, "nuke again");
      const nukeGrantRow = await waitForNewLogRow(baseUrl, "widgets.nuke", before);
      expect(fixture.calls("widgets.nuke")).toBe(2);
      expect((await pendingGate(baseUrl, sessionA)).filter((g) => g.status === "pending")).toHaveLength(0);
      expect(nukeGrantRow.resolvedMode).toBe("allow");
      expect(nukeGrantRow.baseMode).toBe("require_approval");
      expect(nukeGrantRow.matchedGrantId).toBeTruthy();

      // The grant is listed (and revocable) in My grants.
      const grantsRes = await fetch(`${baseUrl}/api/me/grants`, { headers: HEADERS });
      expect(grantsRes.status).toBe(200);
      const grantsBody = (await grantsRes.json()) as ListGrantsResponse;
      const nukeGrant = grantsBody.grants.find((g) => g.sessionId === sessionA && g.policyKey === "widgets.nuke");
      expect(nukeGrant, `grants: ${JSON.stringify(grantsBody.grants)}`).toBeDefined();
      expect(nukeGrant?.id).toBe(nukeGrantRow.matchedGrantId);

      const revokeRes = await fetch(`${baseUrl}/api/me/grants`, {
        method: "DELETE",
        headers: HEADERS,
        body: JSON.stringify({ sessionId: sessionA, service: "widgets", actionId: "widgets.nuke" }),
      });
      expect(revokeRes.status).toBe(200);

      const grantsAfterRevokeRes = await fetch(`${baseUrl}/api/me/grants`, { headers: HEADERS });
      const grantsAfterRevoke = (await grantsAfterRevokeRes.json()) as ListGrantsResponse;
      expect(grantsAfterRevoke.grants.some((g) => g.sessionId === sessionA)).toBe(false);

      // Revoked → gates again.
      queueCallTool(faux, "widgets.nuke", {}, "nuke after revoke");
      await postPrompt(baseUrl, sessionA, "nuke after revoke");
      const reGatedNuke = await waitForGate(baseUrl, sessionA);
      // Re-approve for session (grant resurrection after revoke), then stop
      // the session — the stop must kill the grant.
      await resolveGate(baseUrl, sessionA, reGatedNuke.id, "approve_session");
      await poll(async () => fixture.calls("widgets.nuke"), (n) => n === 3);
      const grantsBeforeStopRes = await fetch(`${baseUrl}/api/me/grants`, { headers: HEADERS });
      const grantsBeforeStop = (await grantsBeforeStopRes.json()) as ListGrantsResponse;
      expect(grantsBeforeStop.grants.some((g) => g.sessionId === sessionA)).toBe(true);

      const stopRes = await fetch(`${baseUrl}/api/sessions/${sessionA}`, { method: "DELETE" });
      expect(stopRes.status).toBe(200);

      const grantsAfterStopRes = await fetch(`${baseUrl}/api/me/grants`, { headers: HEADERS });
      const grantsAfterStop = (await grantsAfterStopRes.json()) as ListGrantsResponse;
      expect(grantsAfterStop.grants.some((g) => g.sessionId === sessionA)).toBe(false);

      // ── (e) Per-user override, self only ─────────────────────────────
      const createSessionBRes = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ workspace: join(workspaceRoot, "sB") }),
      });
      expect(createSessionBRes.status).toBe(201);
      const sessionB = ((await createSessionBRes.json()) as CreateSessionResponse).id;

      const overrideRes = await fetch(`${baseUrl}/api/me/policy-overrides`, {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify({ actionId: "widgets.ping", mode: "require_approval" }),
      });
      expect(overrideRes.status).toBe(200);
      const override = (await overrideRes.json()) as PutPolicyOverrideResponse;

      const beforePingOverride = await knownLogIds(baseUrl, "widgets.ping");
      queueCallTool(faux, "widgets.ping", {}, "ping under override");
      await postPrompt(baseUrl, sessionB, "ping under override");
      const overrideGate = await waitForGate(baseUrl, sessionB);
      await resolveGate(baseUrl, sessionB, overrideGate.id, "approve");
      const pingOverrideRow = await waitForNewLogRow(baseUrl, "widgets.ping", beforePingOverride);
      expect(fixture.calls("widgets.ping")).toBe(2);
      expect(pingOverrideRow).toMatchObject({ resolvedMode: "require_approval", baseMode: "allow", matchedOverrideId: override.id });

      // The SAME override does not apply to a different user — proven via
      // the admin-only resolver preview route (dry-run, no writes).
      const previewRes = await fetch(`${baseUrl}/api/org/policies/preview`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({
          service: "widgets",
          actionId: "widgets.ping",
          riskLevel: "low",
          appliesIn: "session",
          sessionId: sessionB,
          userId: "test-member",
        }),
      });
      expect(previewRes.status).toBe(200);
      const preview = (await previewRes.json()) as PreviewOrgPolicyResponse;
      expect(preview.mode).toBe("allow");

      // Non-admin members cannot see the admin-only surfaces this test used.
      const memberActionLogRes = await fetch(`${baseUrl}/api/org/action-log`, { headers: MEMBER_HEADERS });
      expect(memberActionLogRes.status).toBe(403);

      // ── (f) Workflow enforcement: deny/require_approval matrix + grant ──
      const toolNodeDef = {
        version: "dag/v1",
        nodes: [
          { id: "trigger", type: "trigger" },
          { id: "call", type: "tool", service: "widgets", action: "nuke", params: {} },
          { id: "done", type: "stop" },
        ],
        edges: [
          { from: "trigger", to: "call" },
          { from: "call", to: "done" },
        ],
      };
      const createWfNoGrantRes = await fetch(`${baseUrl}/api/workflows`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ name: "e2e-policy-no-grant", definition: toolNodeDef }),
      });
      expect(createWfNoGrantRes.status).toBe(201);
      const wfNoGrant = (await createWfNoGrantRes.json()) as CreateWorkflowResponse;

      const startNoGrantRes = await fetch(`${baseUrl}/api/workflows/${wfNoGrant.id}/runs`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({}),
      });
      expect(startNoGrantRes.status).toBe(201);
      const { runId: runNoGrant } = (await startNoGrantRes.json()) as StartWorkflowRunResponse;

      // Under the new contract a require_approval tool node parks the run
      // (waiting for a human decision) instead of immediately failing it.
      const parkedNoGrant = await poll(
        async () => {
          const r = await fetch(`${baseUrl}/api/workflows/runs/${runNoGrant}`);
          expect(r.status).toBe(200);
          return (await r.json()) as GetWorkflowRunResponse;
        },
        (r) => r.run.status === "parked",
        15_000,
      );
      const approvalWait = (parkedNoGrant.run.waitingOn as Array<Record<string, unknown>>).find(
        (w) => w.kind === "signal" && w.signalType === "approval:call",
      );
      expect(approvalWait).toBeDefined();
      const pendingCheckpoint = parkedNoGrant.checkpoints.find((c) => c.nodeId === "call");
      expect(pendingCheckpoint?.status).toBe("intent");

      // Deny the gate — the run must settle as failed.
      const denyRes = await fetch(`${baseUrl}/api/workflows/runs/${runNoGrant}/approvals/call`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ approved: false }),
      });
      expect(denyRes.status).toBe(200);
      expect(((await denyRes.json()) as ResolveWorkflowApprovalResponse).ok).toBe(true);

      const settledNoGrant = await poll(
        async () => {
          const r = await fetch(`${baseUrl}/api/workflows/runs/${runNoGrant}`);
          expect(r.status).toBe(200);
          return (await r.json()) as GetWorkflowRunResponse;
        },
        (r) => r.run.status === "settled",
        15_000,
      );
      expect(settledNoGrant.run.outcome).toBe("failed");
      const failedCheckpoint = settledNoGrant.checkpoints.find((c) => c.nodeId === "call");
      expect(failedCheckpoint?.status).toBe("failed");
      expect(failedCheckpoint?.error).toContain("denied by");

      // A second run with an upstream approval node that grants the rest of
      // the run lets the same tool node pass.
      const grantedDef = {
        version: "dag/v1",
        nodes: [
          { id: "trigger", type: "trigger" },
          { id: "approve", type: "approval", prompt: "grant nuke for this run?" },
          { id: "call", type: "tool", service: "widgets", action: "nuke", params: {} },
          { id: "done", type: "stop" },
        ],
        edges: [
          { from: "trigger", to: "approve" },
          { from: "approve", to: "call" },
          { from: "call", to: "done" },
        ],
      };
      const createWfGrantRes = await fetch(`${baseUrl}/api/workflows`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ name: "e2e-policy-with-grant", definition: grantedDef }),
      });
      expect(createWfGrantRes.status).toBe(201);
      const wfGrant = (await createWfGrantRes.json()) as CreateWorkflowResponse;

      const startGrantRes = await fetch(`${baseUrl}/api/workflows/${wfGrant.id}/runs`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({}),
      });
      expect(startGrantRes.status).toBe(201);
      const { runId: runGrant } = (await startGrantRes.json()) as StartWorkflowRunResponse;

      // Park on the approval node first.
      await poll(
        async () => {
          const r = await fetch(`${baseUrl}/api/workflows/runs/${runGrant}`);
          const body = (await r.json()) as GetWorkflowRunResponse;
          return body.checkpoints.find((c) => c.nodeId === "approve")?.status;
        },
        (status) => status === "intent",
        15_000,
      );

      // Approve the upstream approval node (not a policy gate — plain approval).
      const approveNodeRes = await fetch(`${baseUrl}/api/workflows/runs/${runGrant}/approvals/approve`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ approved: true }),
      });
      expect(approveNodeRes.status).toBe(200);
      expect(((await approveNodeRes.json()) as ResolveWorkflowApprovalResponse).ok).toBe(true);

      // Poll for the run to park again on the tool gate (policy gate for `call`).
      await poll(
        async () => {
          const r = await fetch(`${baseUrl}/api/workflows/runs/${runGrant}`);
          expect(r.status).toBe(200);
          return (await r.json()) as GetWorkflowRunResponse;
        },
        (r) =>
          r.run.status === "parked" &&
          (r.run.waitingOn as Array<Record<string, unknown>>).some(
            (w) => w.kind === "signal" && w.signalType === "approval:call",
          ),
        15_000,
      );

      // Resolve the tool gate with scope=run so downstream nodes get the grant.
      const approveGateRes = await fetch(`${baseUrl}/api/workflows/runs/${runGrant}/approvals/call`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ approved: true, scope: "run" }),
      });
      expect(approveGateRes.status).toBe(200);
      expect(((await approveGateRes.json()) as ResolveWorkflowApprovalResponse).ok).toBe(true);

      const settledGrant = await poll(
        async () => {
          const r = await fetch(`${baseUrl}/api/workflows/runs/${runGrant}`);
          expect(r.status).toBe(200);
          return (await r.json()) as GetWorkflowRunResponse;
        },
        (r) => r.run.status === "settled",
        15_000,
      );
      expect(settledGrant.run.outcome).toBe("completed");
      const completedCheckpoint = settledGrant.checkpoints.find((c) => c.nodeId === "call");
      expect(completedCheckpoint?.status).toBe("completed");
      expect(completedCheckpoint?.result).toEqual({ nuked: true });

      // ── (g) Every step's row appears in the Action Log with correct
      //      provenance — spot-check both workflow rows here (session rows
      //      were already checked inline above, right after each step). ──
      const allEntries = await actionLog(baseUrl, { service: "widgets" });
      const wfRows = allEntries.filter((e) => e.workflowExecutionId === runNoGrant || e.workflowExecutionId === runGrant);
      expect(wfRows.length).toBeGreaterThanOrEqual(2);
      const wfDeniedRow = wfRows.find((e) => e.workflowExecutionId === runNoGrant);
      // The gate audit row is written as "pending" when the run parks; the
      // denial resolves it — the HTTP route stamps "denied" via updateInvocationOutcome.
      expect(wfDeniedRow).toMatchObject({ resolvedMode: "require_approval", status: "denied" });
      // The scope:run grant flow: the policy gate parks the run (pending), the
      // human approves via HTTP, and the tool runs with the approval field.
      // The audit row ends up require_approval/completed — the enforcer writes
      // "approved" when the approval field is present, then updateInvocationOutcome
      // stamps "completed" after the action actually executes.
      const wfGrantedRow = wfRows.find((e) => e.workflowExecutionId === runGrant);
      expect(wfGrantedRow).toMatchObject({ resolvedMode: "require_approval", status: "completed" });
      // The decision row is stamped with the execution outcome + result when
      // the node eventually completes (spec Deviations T6 #6, fixed).
      expect(wfGrantedRow?.result).toEqual({ success: true, data: { nuked: true } });
    },
    60_000,
  );
});
