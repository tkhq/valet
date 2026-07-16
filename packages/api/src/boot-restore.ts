/**
 * Boot-restore session routing (Phase 5, boot-restore fix follow-up).
 * Extracted out of `main.ts` so the `wf:` vs regular-session routing
 * decision can be unit-tested without importing `main.ts` — which runs
 * side-effecting boot code (env checks, `buildNodeProviders`, `process.exit`)
 * at module load time and cannot be safely imported from a test.
 *
 * See CLAUDE.md's persistence-shape-drift guidance: this routing decision
 * used to be exercised only by the key-gated Docker E2E.
 */

/**
 * Narrow, dependency-injected surface for {@link restoreOneSession} — lets
 * the routing decision be unit-tested without a real
 * `EngineHost`/`Providers`/sqlite db. Production callers (`main.ts`) build
 * this from `Providers`.
 */
export interface RestoreSessionDeps {
  ensureWorkflowSession: (sessionId: string) => Promise<{ id: string }>;
  lookupAgentSession: (
    sessionId: string,
  ) => Promise<
    { userId: string; orgId: string; workspace: string; profile: "headless" | "full" } | undefined
  >;
  sessionFor: (
    sessionId: string,
    meta: { userId: string; orgId: string; workspace: string; profile: "headless" | "full" },
  ) => Promise<unknown>;
}

/**
 * Routes a single unsettled-submission session id to the right restore path
 * and materializes it.
 *
 * Workflow sessions (`wf:{runId}:{nodeId}`) have no `agent_sessions` app
 * row — their context lives in `workflow_runs` — so they must be
 * materialized through the workflow engine-deps path instead of the
 * app-row lookup. Without this branch a restart mid-session-node leaves the
 * workflow run parked on a submission that never settles.
 *
 * Does NOT catch errors itself — callers are responsible for per-session
 * isolation (see the try/catch around each call in `main.ts`'s
 * `restoreUnsettledSessions`), so one bad row can't stall the rest of boot.
 */
export async function restoreOneSession(sessionId: string, deps: RestoreSessionDeps): Promise<void> {
  if (sessionId.startsWith("wf:")) {
    await deps.ensureWorkflowSession(sessionId);
    return;
  }
  const row = await deps.lookupAgentSession(sessionId);
  if (!row) {
    console.warn(`boot restore: skipping ${sessionId} — no app session row`);
    return;
  }
  await deps.sessionFor(sessionId, row);
}
