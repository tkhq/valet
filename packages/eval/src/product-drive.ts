/**
 * Product-mode driver (adversarial-review finding 8).
 *
 * `drive: product` cases measure the PRODUCTION agent, not a lab replica:
 * the harness boots the real api in-process (fresh scratch PGlite per case
 * — no cross-case state), ensures the real orchestrator session over
 * `POST /api/workspaces/user/runtime` (real persona, real HTTP-backed mem_* tools,
 * real plugin catalog and policy, real ChildWatcher), and drives every
 * turn over the public message route. Reads go through the back door: the
 * harness owns the providers, so settlement is polled on the engine store
 * and trajectories extract from the same entries production persists.
 *
 * This is the drive-through-the-front-door / read-through-the-back-door
 * shape from the original eval-harness design discussion on TKAI-213.
 *
 * Scope: `session_type: orchestrator` only — the orchestrator IS the
 * production agent surface. Plain interactive product sessions (Docker
 * workspace provisioning per case) can be added behind the same seam.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { createApp } from "@valet/api/app";
import { buildNodeProviders } from "@valet/api/providers-node";
import { connectEvalPlaceholders } from "@valet/api/eval-connections";
import { listChildSessions } from "@valet/api/eval-flagged";
import { listSavedWorkflows } from "@valet/api/eval-workflows";
import type { SessionEntry } from "@valet/engine";
import { interpolateTurnContent, type CaseOutcome, type CaseRunResult } from "./runner.js";
import { extractTrajectory, findSpawnCallId } from "./trajectory.js";
import type { EvalCase, Trajectory } from "./types.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const POLL_MS = 150;
/** Extra settle-wait after the last submission, for straggler child signals. */
const QUIESCENCE_MS = 1_000;
/**
 * The typed answer to an `ask_question` card. Nobody watches an eval run,
 * so the harness answers like a person who leaves the choice to the agent.
 */
export const EVAL_QUESTION_ANSWER = "I am not available to choose. Use your best judgment and list what you assumed.";
/** Action ids that decline a decision card, in order of preference. */
const DECLINE_ACTION_IDS = ["cancel", "deny", "reject", "decline"];

/** One decision card the harness answered during a product case. */
export interface EvalDecision {
  type: string;
  title: string;
  /** The action id or typed answer the harness sent. */
  answer: string;
}

interface PendingGate {
  id: string;
  type: string;
  title: string;
  actions: Array<{ id: string; style?: string }>;
}

/**
 * How the harness answers a decision card: a typed answer for a question,
 * else the action that declines it ("Not now", "Deny"). A declined card
 * changes nothing, so the case measures what the agent built before it.
 */
export function evalGateAnswer(gate: PendingGate): { actionId: string } | { value: string } {
  if (gate.type === "question") return { value: EVAL_QUESTION_ANSWER };
  const decline =
    DECLINE_ACTION_IDS.map((id) => gate.actions.find((action) => action.id === id)).find((action) => action !== undefined) ??
    gate.actions.find((action) => action.style !== "primary");
  if (decline !== undefined) return { actionId: decline.id };
  return { value: "No." };
}

export interface ProductDriveOptions {
  /** Model spec for the run. The driver saves it as the person's default
   * model before the assistant session exists, so the assistant runs on it. */
  model: string;
  timeoutMs?: number;
  /** API key for the booted api's engine host. Default: process env. */
  anthropicApiKey?: string;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        rejectPort(new Error("could not allocate a port"));
        return;
      }
      srv.close(() => resolvePort(addr.port));
    });
    srv.on("error", rejectPort);
  });
}

/** Run one `drive: product` case against a freshly booted in-process api. */
export async function runProductCase(evalCase: EvalCase, opts: ProductDriveOptions): Promise<CaseRunResult> {
  if (evalCase.session_type !== "orchestrator") {
    throw new Error(
      `case ${evalCase.id}: drive: product currently requires session_type: orchestrator ` +
        "(the production agent surface). Set session_type, or use the engine drive.",
    );
  }
  const apiKey = opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(`case ${evalCase.id}: drive: product needs ANTHROPIC_API_KEY (the booted api makes real LLM calls).`);
  }

  const timeoutMs = evalCase.timeout_ms ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  const root = await mkdtemp(join(tmpdir(), `valet-eval-product-${evalCase.id}-`));
  const port = await getFreePort();
  const prevLocalAuth = process.env.VALET_LOCAL_AUTH;
  process.env.VALET_LOCAL_AUTH = "1";
  const providers = await buildNodeProviders({
    pgDataDir: resolve(root, "pg"),
    blobsRoot: resolve(root, "blobs"),
    encryptionKey: "eval",
    anthropicApiKey: apiKey,
    apiBaseUrl: `http://127.0.0.1:${port}`,
  });
  const { startServer } = createApp(providers);
  const server = await new Promise<ReturnType<typeof startServer>>((resolveListen) => {
    const s = startServer({ port, onListen: () => resolveListen(s) });
  });
  const baseUrl = `http://127.0.0.1:${port}`;

  const placeholderEnv: string[] = [];
  const shutdown = async (): Promise<void> => {
    for (const name of placeholderEnv) delete process.env[name];
    try {
      await providers.engineHost.destroyAll();
    } catch {
      // Sandboxes are virtual/absent for orchestrator cases; best-effort.
    }
    await server.close();
    if (prevLocalAuth === undefined) delete process.env.VALET_LOCAL_AUTH;
    else process.env.VALET_LOCAL_AUTH = prevLocalAuth;
    await rm(root, { recursive: true, force: true });
  };

  try {
    // The assistant's model comes from the person's default model, so set
    // it before the session exists. Without this, every product case runs
    // on the host fallback tier and `--model` changes only the label.
    const modelRes = await fetch(`${baseUrl}/api/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultModel: opts.model }),
    });
    if (!modelRes.ok) {
      throw new Error(`set default model ${opts.model} failed: ${modelRes.status} ${await modelRes.text()}`);
    }
    const me = (await modelRes.json()) as { id: string; orgId: string };
    if (evalCase.connected !== undefined && evalCase.connected.length > 0) {
      const connected = await connectEvalPlaceholders({
        credentials: providers.engineCredentials,
        userId: me.id,
        orgId: me.orgId,
        services: evalCase.connected,
        env: process.env,
      });
      placeholderEnv.push(...connected.envNames);
    }

    // ── The real orchestrator session, through the front door.
    const ensureRes = await fetch(`${baseUrl}/api/workspaces/user/runtime`, { method: "POST" });
    if (!ensureRes.ok) {
      throw new Error(`ensure orchestrator failed: ${ensureRes.status} ${await ensureRes.text()}`);
    }
    const { sessionId } = (await ensureRes.json()) as { sessionId: string };

    const remaining = (): number => deadline - Date.now();
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

    let outcome: CaseOutcome = "completed";
    let error: string | undefined;
    let threadId: string | undefined;
    let lastOutput: string | undefined;
    const decisions: EvalDecision[] = [];

    // A decision card (ask_question, allow_permissions, a policy approval)
    // holds the tool call open until a person answers it. Answer each one
    // so the turn can end instead of running to the case timeout.
    const answerDecisions = async (): Promise<void> => {
      const decisionsUrl = `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/decisions`;
      const res = await fetch(decisionsUrl);
      if (!res.ok) return;
      const { gates } = (await res.json()) as { gates: PendingGate[] };
      for (const gate of gates) {
        const answer = evalGateAnswer(gate);
        // A gate id carries the tool arguments, so it must be encoded.
        const resolved = await fetch(`${decisionsUrl}/${encodeURIComponent(gate.id)}/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(answer),
        });
        if (!resolved.ok) {
          throw new Error(`answer decision ${gate.id} failed: ${resolved.status} ${await resolved.text()}`);
        }
        decisions.push({ type: gate.type, title: gate.title, answer: "actionId" in answer ? answer.actionId : answer.value });
      }
    };

    const lastAssistantText = async (): Promise<string | undefined> => {
      if (threadId === undefined) return undefined;
      const entries = await providers.engineStore.getEntries(sessionId, threadId);
      const assistant = [...entries]
        .reverse()
        .find((e): e is SessionEntry & { content: string } => e.type === "message" && e.role === "assistant");
      return assistant?.content;
    };

    const awaitSettled = async (queueItemId: string): Promise<boolean> => {
      for (;;) {
        if (remaining() <= 0) {
          outcome = "timeout";
          error = `case timed out after ${timeoutMs}ms`;
          return false;
        }
        const item = await providers.engineStore.getQueueItem(sessionId, queueItemId);
        if (item?.status === "settled") {
          const o = item.outcome?.outcome;
          if (o === "failed" || o === "aborted") {
            outcome = o;
            error = item.outcome?.error ?? `submission ${o}`;
            return false;
          }
          return true;
        }
        if (item?.status === "blocked_on_decision_gate") await answerDecisions();
        await sleep(POLL_MS);
      }
    };

    // Wait until nothing is running: no unsettled submissions and no
    // unsettled child watches, held for QUIESCENCE_MS (a settling child
    // admits a new parent signal turn).
    const awaitQuiescence = async (): Promise<boolean> => {
      let quietSince: number | undefined;
      for (;;) {
        if (remaining() <= 0) {
          outcome = "timeout";
          error = `case timed out after ${timeoutMs}ms waiting for quiescence`;
          return false;
        }
        const unsettled = await providers.engineStore.listUnsettledSubmissions(sessionId);
        const children = await listChildSessions(providers.db, sessionId);
        const busy = unsettled.length > 0 || children.some((c) => !c.settled);
        if (busy) {
          quietSince = undefined;
        } else if (quietSince === undefined) {
          quietSince = Date.now();
        } else if (Date.now() - quietSince >= QUIESCENCE_MS) {
          return true;
        }
        await sleep(POLL_MS);
      }
    };

    for (const [i, turn] of evalCase.turns.entries()) {
      let content: string;
      try {
        content = interpolateTurnContent(turn.content, lastOutput);
      } catch (err) {
        outcome = "failed";
        error = `turn ${i + 1}: ${err instanceof Error ? err.message : String(err)}`;
        break;
      }
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: content }),
      });
      if (!res.ok) {
        outcome = "failed";
        error = `POST message failed: ${res.status} ${await res.text()}`;
        break;
      }
      const body = (await res.json()) as { messageId: string | null; threadId: string };
      threadId = body.threadId;
      if (body.messageId === null) {
        outcome = "failed";
        error = "the prompt executed as a slash command; eval turns must be prompts";
        break;
      }
      if (!(await awaitSettled(body.messageId))) break;
      if (!(await awaitQuiescence())) break;
      lastOutput = await lastAssistantText();
    }

    // ── Read through the back door: the production-persisted entries.
    const durationMs = Date.now() - startedAt;
    const entries =
      threadId !== undefined ? await providers.engineStore.getEntries(sessionId, threadId) : [];

    const childTrajectories: Trajectory[] = [];
    const children = await listChildSessions(providers.db, sessionId);
    for (const [i, child] of children.entries()) {
      const childThreads = await providers.engineStore.listThreads(child.childSessionId);
      const childEntries: SessionEntry[] = [];
      for (const t of childThreads) {
        childEntries.push(...(await providers.engineStore.getEntries(child.childSessionId, t.id)));
      }
      const trajectory = extractTrajectory({
        caseId: `${evalCase.id}#child-${i}`,
        prompt:
          childEntries.find((e): e is SessionEntry & { content: string } => e.type === "message" && e.role === "user")
            ?.content ?? "",
        model: opts.model,
        durationMs: 0,
        entries: childEntries,
      });
      const spawnCall = findSpawnCallId(entries, child.childSessionId);
      if (spawnCall !== undefined) trajectory.spawnedByCallId = spawnCall;
      childTrajectories.push(trajectory);
    }

    // Workflow-authoring checks score what the case saved, including edits
    // that only a patch made.
    const savedWorkflows = await listSavedWorkflows(providers.db);
    // The models the assistant's replies name, so a run shows what it ran
    // on, not only the label it was asked for.
    const assistantModels = [
      ...new Set(
        entries.flatMap((e) => (e.type === "message" && e.role === "assistant" && e.model !== undefined ? [e.model] : [])),
      ),
    ];
    const trajectory = extractTrajectory({
      caseId: evalCase.id,
      prompt: evalCase.turns[0].content,
      model: opts.model,
      durationMs,
      entries,
      metadata: {
        drive: "product",
        sessionId,
        assistantModels,
        ...(decisions.length > 0 ? { decisions } : {}),
        ...(savedWorkflows.length > 0 ? { savedWorkflows } : {}),
      },
      children: childTrajectories,
    });

    return { trajectory, outcome, ...(error !== undefined ? { error } : {}) };
  } finally {
    await shutdown();
  }
}
