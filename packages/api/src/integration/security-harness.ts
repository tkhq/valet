/**
 * Shared helpers for the security acceptance suite (M10) — the same boot,
 * dispatch, act-as-child, and settle-by-abort mechanics the M3–M6 suites
 * (security-settlement, security-persona, security-yield, security-triage)
 * proved one at a time. Extracted here because the acceptance scenarios
 * repeat the full cycle many times per test.
 *
 * The mechanics, pinned by the earlier suites:
 *   - No ANTHROPIC_API_KEY and no model turn. The runner thread is paused
 *     so admitted signals stay observable; children settle by abort (the
 *     engine settles queued AND in-flight work `aborted` — a real
 *     settlement, which is all the watcher and the complete route need).
 *   - `sec_*` tool calls are emulated as the tools perform them: internal
 *     token + `x-valet-session-id` naming the ACTING session (the runner
 *     for runner routes, the dispatched child for persona routes).
 *   - A 40-hex repo ref short-circuits SHA resolution, so the start route
 *     stays offline-deterministic.
 *
 * Underscore-free filename is fine: vitest only picks up `*.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import type { TestApi } from "./_setup.js";
import { internalToken } from "../lib/internal-auth.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, childWatches } from "../schema/index.js";
import type {
  CreateSessionResponse,
  GetSessionSecurityResponse,
  SecurityCompleteCellResponse,
  SecurityDispatchResponse,
  SecurityReportFindingResponse,
  SecurityWriteFileResponse,
} from "../wire/types.js";

/** The engagement's pinned commit — a fake 40-hex SHA the start route
 * accepts without a GitHub lookup. */
export const FAKE_SHA = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";

export const REPO = {
  fullName: "acme/api",
  cloneUrl: "https://github.com/acme/api.git",
  ref: FAKE_SHA,
};

/** ≥ 200 characters of evidence, per the finding body floor. */
export const EVIDENCE =
  "The login handler at src/auth/login.ts builds its SQL with string concatenation: " +
  '`db.query("SELECT * FROM users WHERE name = \'" + req.body.name + "\'")`. ' +
  "Attacker-controlled req.body.name reaches the query text unescaped, so a single quote breaks out " +
  "of the literal and injects arbitrary SQL — full table read via UNION SELECT.";

/** Headers the sec_* tools send: internal token + the acting session. */
export function actingAs(sessionId: string, json = true): Record<string, string> {
  return {
    "x-valet-internal": internalToken(),
    "x-valet-session-id": sessionId,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 20_000,
  label = "condition",
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor: timed out waiting for ${label}`);
}

/** A protocol-valid state doc with the given status and counts. */
export function stateDoc(args: {
  status: "working" | "yielding" | "done";
  checklist?: { pending: number; done: number };
  queue?: { pending: number; done: number };
}): string {
  const checklist = args.checklist ?? { pending: 0, done: 1 };
  const queue = args.queue ?? { pending: 0, done: 1 };
  return [
    "protocol_version: 1",
    `status: ${args.status}`,
    "checklist:",
    `  pending: ${checklist.pending}`,
    `  done: ${checklist.done}`,
    "queue:",
    `  pending: ${queue.pending}`,
    `  done: ${queue.done}`,
  ].join("\n");
}

/** REST-create a kind='security' session with the repo binding pinned to
 * the fake SHA; returns the session id and the seeded engagement id. */
export async function createSecuritySession(
  api: TestApi,
): Promise<{ sessionId: string; engagementId: string }> {
  const createRes = await fetch(`${api.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspace: `/tmp/valet-sec-acceptance-${randomUUID()}`,
      kind: "security",
      repo: REPO,
    }),
  });
  expect(createRes.status).toBe(201);
  const created = (await createRes.json()) as CreateSessionResponse;
  const security = await fetch(`${api.baseUrl}/api/sessions/${created.id}/security`);
  expect(security.status).toBe(200);
  const body = (await security.json()) as GetSessionSecurityResponse;
  return { sessionId: created.id, engagementId: body.engagement.id };
}

/**
 * Build the runner engine session (the same first-touch every web caller
 * performs) and PAUSE it, so admitted signals stay queued and observable
 * instead of being claimed by a doomed no-API-key turn. Returns the durable
 * default thread id — the thread dispatches name and settlement signals
 * land on.
 */
export async function buildPausedRunner(api: TestApi, sessionId: string): Promise<{ threadId: string }> {
  const { db, engineHost } = api.providers;
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
  const runner = await engineHost.sessionFor(sessionId, await loadSessionMeta(db, rows[0]));
  const thread = runner.thread("web:default");
  await runner.pause();
  return { threadId: thread.id };
}

/** POST .../security/plan as the runner (the sec_plan_set backend). */
export async function setPlanViaRoute(api: TestApi, sessionId: string, plan: string): Promise<number> {
  const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/security/plan`, {
    method: "POST",
    headers: actingAs(sessionId),
    body: JSON.stringify({ plan }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { cellCount: number };
  return body.cellCount;
}

/** POST .../security/start as the runner (the sec_start backend past the
 * approval gate): materializes cells and pins the SHA. */
export async function startViaRoute(
  api: TestApi,
  sessionId: string,
  resolvedSha = FAKE_SHA,
): Promise<GetSessionSecurityResponse> {
  const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/security/start`, {
    method: "POST",
    headers: actingAs(sessionId),
    body: JSON.stringify({ resolvedSha }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as GetSessionSecurityResponse;
}

/** POST .../security/dispatch as the runner (the sec_dispatch backend). */
export async function dispatchViaRoute(
  api: TestApi,
  sessionId: string,
  threadId: string,
  body: { cellId?: string; mode?: "fresh" | "resume" } = {},
): Promise<SecurityDispatchResponse> {
  const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/security/dispatch`, {
    method: "POST",
    headers: actingAs(sessionId),
    body: JSON.stringify({ ...body, threadId }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SecurityDispatchResponse;
}

/** Write one engagement-tree revision acting AS the dispatched child. */
export async function writeFileAsChild(
  api: TestApi,
  childSessionId: string,
  path: string,
  content: string,
): Promise<SecurityWriteFileResponse> {
  const res = await fetch(`${api.baseUrl}/api/sessions/${childSessionId}/security/files`, {
    method: "POST",
    headers: actingAs(childSessionId),
    body: JSON.stringify({ path, content }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SecurityWriteFileResponse;
}

/** Report a finding acting AS the dispatched child. */
export async function reportFindingAsChild(
  api: TestApi,
  childSessionId: string,
  finding: { severity: string; title: string; file?: string; line?: number; body: string },
): Promise<SecurityReportFindingResponse> {
  const res = await fetch(`${api.baseUrl}/api/sessions/${childSessionId}/security/findings`, {
    method: "POST",
    headers: actingAs(childSessionId),
    body: JSON.stringify(finding),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SecurityReportFindingResponse;
}

/** The durable child-watch settled flag — the same signal the complete
 * route trusts. */
export async function watchSettled(db: AppDb, childSessionId: string): Promise<boolean> {
  const rows = await db
    .select({ settled: childWatches.settled })
    .from(childWatches)
    .where(eq(childWatches.childSessionId, childSessionId))
    .limit(1);
  return rows[0]?.settled === true;
}

/** Settle a dispatched child without a model: abort settles its real
 * dispatched submission `aborted`, then wait for the watcher to observe it
 * and mark the durable watch settled. */
export async function settleChildByAbort(api: TestApi, childSessionId: string): Promise<void> {
  const { db, engineHost } = api.providers;
  await engineHost.liveSession(childSessionId)?.abort();
  await waitFor(() => watchSettled(db, childSessionId), 20_000, `watch settled for ${childSessionId}`);
}

/** POST .../security/cells/:cellId/complete as the runner. */
export async function completeCellViaRoute(
  api: TestApi,
  sessionId: string,
  cellId: string,
): Promise<SecurityCompleteCellResponse> {
  const res = await fetch(
    `${api.baseUrl}/api/sessions/${sessionId}/security/cells/${cellId}/complete`,
    { method: "POST", headers: actingAs(sessionId), body: JSON.stringify({}) },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as SecurityCompleteCellResponse;
}

/** GET .../security — the web panel's read; carries running-cell progress. */
export async function getSecurity(api: TestApi, sessionId: string): Promise<GetSessionSecurityResponse> {
  const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/security`);
  expect(res.status).toBe(200);
  return (await res.json()) as GetSessionSecurityResponse;
}

/** The child's queued dispatch prompt, read from its unsettled submission
 * (the yield suite's prompt-assertion mechanism). */
export async function queuedPromptOf(api: TestApi, childSessionId: string): Promise<string> {
  const items = await api.providers.engineStore.listUnsettledSubmissions(childSessionId);
  expect(items).toHaveLength(1);
  return typeof items[0].content === "string" ? items[0].content : JSON.stringify(items[0].content);
}

/** One dispatch → child writes a done state doc → settle → complete cycle
 * for cells whose content does not matter to the scenario. */
export async function runCellToCompletion(
  api: TestApi,
  sessionId: string,
  threadId: string,
): Promise<SecurityDispatchResponse> {
  const dispatched = await dispatchViaRoute(api, sessionId, threadId);
  const childId = dispatched.cell.childSessionId;
  expect(childId).toBeTruthy();
  await writeFileAsChild(
    api,
    childId!,
    `/cells/${dispatched.cell.dir}/state.yml`,
    stateDoc({ status: "done" }),
  );
  await settleChildByAbort(api, childId!);
  const ruling = await completeCellViaRoute(api, sessionId, dispatched.cell.id);
  expect(ruling.outcome).toBe("completed");
  return dispatched;
}
