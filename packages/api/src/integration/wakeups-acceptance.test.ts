/**
 * The acceptance scenario of the sandbox scratch, wakeups, and leases spec
 * (`docs/specs/2026-10-08-sandbox-scratch-wakeups-leases-design.md`), steps
 * 2, 4, 6, 8, 9, and 10. Steps 1, 3, 5, and 7 need a kubernetes pod and an
 * idle clock; their unit suites own them.
 *
 * The test drives the wakeups seam directly (the seam the `bash`, `wake_at`
 * tools call) and the WakeWatcher by hand with an explicit `now`. A fake
 * model answers each signal turn, so no network call happens.
 */
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  builtinTools,
  VirtualSandbox,
  type ExecJobHandle,
  type JobPoll,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxProvider,
  type SandboxStatus,
  type Session,
  type ToolContext,
} from "@valet/engine";
import { isScratchRequestError } from "@valet/shared";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WakeWatcher } from "../engine/wake-watcher.js";
import { agentSessions } from "../schema/index.js";
import type { CreateSessionResponse, ListMessagesResponse, ListThreadsResponse, Message } from "../wire/types.js";
import { bootTestApi, type TestApi } from "./_setup.js";

const HOUR_MS = 3_600_000;

/** One background job the test drives by hand. */
interface ScriptedJob {
  command: string;
  poll: JobPoll;
  cancelled: boolean;
}

/** A virtual sandbox whose background jobs stay running until the test ends them. */
class ScriptedSandbox extends VirtualSandbox {
  readonly jobTable = new Map<string, ScriptedJob>();
  private nextScripted = 1;

  override async execJob(command: string): Promise<ExecJobHandle> {
    const execId = `scripted-${this.nextScripted++}`;
    this.jobTable.set(execId, { command, poll: { status: "running", output: "", nextOffset: 0 }, cancelled: false });
    return { execId };
  }

  override async pollJob(execId: string, offset: number): Promise<JobPoll> {
    const job = this.jobTable.get(execId);
    if (!job) return { status: "failed", output: "", nextOffset: offset };
    const all = job.poll.output;
    return { ...job.poll, output: all.slice(offset), nextOffset: all.length };
  }

  override async cancelJob(execId: string): Promise<void> {
    const job = this.jobTable.get(execId);
    if (job) job.cancelled = true;
  }

  /** Ends a job with an exit code and its full output. */
  finish(execId: string, exitCode: number, output: string): void {
    const job = this.jobTable.get(execId);
    if (!job) throw new Error(`no scripted job ${execId}`);
    job.poll = { status: "done", exitCode, output, nextOffset: output.length };
  }
}

/** A sandbox provider with scripted jobs and a recorded eviction-protection seam. */
class ScriptedSandboxProvider implements SandboxProvider {
  readonly backend = "virtual";
  readonly sandboxes = new Map<string, ScriptedSandbox>();
  readonly protectedIds = new Set<string>();
  readonly protectionCalls: Array<[string, boolean]> = [];
  private nextId = 1;

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: false,
      tunnels: false,
      warmPool: false,
      hibernation: false,
      customImage: false,
      nestedKubernetes: false,
      coldStartEstimateMs: 0,
    };
  }

  async create(): Promise<Sandbox> {
    const sb = new ScriptedSandbox(`ssb-${this.nextId++}`);
    this.sandboxes.set(sb.id, sb);
    return sb;
  }

  async restore(id: string): Promise<Sandbox> {
    const sb = this.sandboxes.get(id);
    if (!sb) throw new Error(`scripted sandbox not found: ${id}`);
    return sb;
  }

  async destroy(id: string): Promise<void> {
    this.sandboxes.delete(id);
  }

  async status(id: string): Promise<SandboxStatus> {
    return this.sandboxes.has(id) ? { id, state: "ready", startedAt: Date.now() } : { id, state: "released" };
  }

  async setEvictionProtection(id: string, enabled: boolean): Promise<{ changed: boolean }> {
    this.protectionCalls.push([id, enabled]);
    const had = this.protectedIds.has(id);
    if (enabled) this.protectedIds.add(id);
    else this.protectedIds.delete(id);
    return { changed: had !== enabled };
  }

  async listEvictionProtected(): Promise<string[]> {
    return [...this.protectedIds];
  }
}

let api: TestApi | undefined;
let unregister: (() => void) | undefined;

afterEach(async () => {
  unregister?.();
  unregister = undefined;
  await api?.cleanup();
  api = undefined;
  vi.unstubAllEnvs();
});

async function threadMessages(baseUrl: string, sessionId: string, threadId: string): Promise<Message[]> {
  const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages?threadId=${encodeURIComponent(threadId)}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as ListMessagesResponse;
  return body.messages;
}

/** The rows of a raw `db.execute` result, whose driver type is not exported. */
function rowsOf(result: unknown): unknown[] {
  if (result !== null && typeof result === "object" && "rows" in result && Array.isArray(result.rows)) {
    return result.rows;
  }
  throw new Error("db.execute returned no rows array");
}

function signalsOf(messages: Message[], signalType: string): Message[] {
  return messages.filter((m) => m.signal?.signalType === signalType);
}

/** A tool context with only what the `task` tool reads. */
function taskToolContext(session: Session, threadId: string, spawner: unknown): ToolContext {
  return {
    userId: "local-user",
    orgId: "local-org",
    sessionId: session.id,
    threadId,
    credentials: {
      get: async () => null,
      request: async () => {
        throw new Error("credentials are not used by this test");
      },
    },
    sandbox: session.sandbox,
    requestDecision: async () => {
      throw new Error("decisions are not used by this test");
    },
    signal: new AbortController().signal,
    threadRead: async () => [],
    listThreads: async () => [],
    setModel: async () => {
      throw new Error("model switches are not used by this test");
    },
    config: { childSpawner: spawner },
  };
}

describe("api integration: wakeups acceptance scenario", () => {
  it("runs spec acceptance steps 2, 4, 6, 8, 9, and 10 in one run", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture-key");
    vi.stubEnv("VALET_SANDBOX_SCRATCH_MAX", "1Ti");
    vi.stubEnv("VALET_SANDBOX_SCRATCH_AGENT_MAX", "100Gi");
    const faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    unregister = () => faux.unregister();
    faux.appendResponses([
      fauxAssistantMessage("Read the process exit."),
      fauxAssistantMessage("Checked the proof report."),
    ]);

    const provider = new ScriptedSandboxProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const p = api.providers;
    const baseUrl = api.baseUrl;

    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: "/tmp" }),
    });
    expect(created.status).toBe(201);
    const { id: sessionId } = (await created.json()) as CreateSessionResponse;
    const threadsRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/threads`);
    const { threads } = (await threadsRes.json()) as ListThreadsResponse;
    const threadId = threads[0]?.id;
    if (!threadId) throw new Error("created session has no default thread");

    const session = p.engineHost.liveSession(sessionId);
    if (!session) throw new Error(`session ${sessionId} is not live after create`);
    const wakeups = session.options.wakeups;
    if (!wakeups) throw new Error("the session has no wakeups seam");

    // Step 2: bash { background: true, deadline_hours: 48, reason }.
    const t0 = Date.now();
    const started = await wakeups.create(threadId, {
      kind: "process",
      command: "lake build",
      reason: "full proof build",
      deadlineHours: 48,
    });
    const { wakeup: proc, lease } = started;
    if (!lease || proc.execId === undefined) throw new Error("a process wakeup returns a lease and an exec id");
    expect(proc.id).toMatch(/^wk_/);
    expect(proc).toMatchObject({ kind: "process", status: "running", leaseId: lease.id });
    expect(lease).toMatchObject({ ownerKind: "process", ownerId: proc.id, reason: "full proof build" });
    expect(lease.deadlineAt - lease.createdAt).toBe(48 * HOUR_MS);
    const sandboxId = lease.sandboxId;
    if (sandboxId === undefined) throw new Error("the process lease names no sandbox");
    const sandbox = provider.sandboxes.get(sandboxId);
    if (!sandbox) throw new Error(`no scripted sandbox ${sandboxId}`);
    expect(sandbox.jobTable.get(proc.execId)?.command).toBe("lake build");

    await p.wakeWatcher.sweep(t0 + 60_000);
    expect(provider.protectionCalls).toContainEqual([sandboxId, true]);
    expect(await p.engineStore.getWakeup(proc.id)).toMatchObject({ status: "running" });

    // Step 4: the api restarts. A new watcher on the same store re-adopts the row.
    const restarted = new WakeWatcher({
      db: p.db,
      engineStore: p.engineStore,
      engineHost: p.engineHost,
      provider,
      limits: wakeups.limits,
      sweepIntervalMs: 0,
    });
    await restarted.sweep(t0 + 120_000);
    expect(await p.engineStore.getWakeup(proc.id)).toMatchObject({ status: "running" });
    expect((await p.engineStore.listActiveLeases(sessionId)).map((l) => l.id)).toEqual([lease.id]);
    expect(signalsOf(await threadMessages(baseUrl, sessionId, threadId), "process.exited")).toHaveLength(0);
    expect(sandbox.jobTable.get(proc.execId)?.cancelled).toBe(false);

    // Step 6: the process exits 0. One process.exited signal lands on the thread.
    sandbox.finish(proc.execId, 0, "Build completed successfully.\n");
    await restarted.sweep(t0 + 31 * HOUR_MS);
    await vi.waitFor(async () => {
      const exited = signalsOf(await threadMessages(baseUrl, sessionId, threadId), "process.exited");
      expect(exited).toHaveLength(1);
      expect(exited[0]?.content).toBe("Build completed successfully.\n");
      expect(exited[0]?.signal?.attributes).toMatchObject({
        wakeupId: proc.id,
        cause: "exit",
        exitCode: "0",
        reason: "full proof build",
      });
    }, { timeout: 10_000 });
    expect(await p.engineStore.getWakeup(proc.id)).toMatchObject({ status: "done", cause: "exit", exitCode: 0 });
    expect(await p.engineStore.countActiveLeases(sessionId)).toBe(0);
    const released = await p.db.execute(sql`SELECT release_cause FROM engine_leases WHERE id = ${lease.id}`);
    expect(rowsOf(released)).toEqual([{ release_cause: "owner_ended" }]);
    // The same tick that released the lease clears the protection.
    expect(provider.protectionCalls.at(-1)).toEqual([sandboxId, false]);
    expect(provider.protectedIds.has(sandboxId)).toBe(false);

    // Step 8: wake_at { after_seconds: 7200, prompt }. A timer holds no lease.
    const t1 = t0 + 31 * HOUR_MS + 60_000;
    const { wakeup: timer, lease: timerLease } = await wakeups.create(threadId, {
      kind: "timer",
      prompt: "Check the proof report",
      fireAt: t1 + 7_200_000,
    });
    expect(timerLease).toBeUndefined();
    expect(timer).toMatchObject({ kind: "timer", status: "pending", fireAt: t1 + 7_200_000 });
    expect(await p.engineStore.countActiveLeases(sessionId)).toBe(0);
    await restarted.sweep(t1 + 7_199_000);
    expect(await p.engineStore.getWakeup(timer.id)).toMatchObject({ status: "pending" });

    // Step 9: two hours pass. One timer.fired signal carries the prompt.
    await restarted.sweep(t1 + 7_200_000);
    await vi.waitFor(async () => {
      const fired = signalsOf(await threadMessages(baseUrl, sessionId, threadId), "timer.fired");
      expect(fired).toHaveLength(1);
      expect(fired[0]?.content).toBe("Check the proof report");
      expect(fired[0]?.signal?.attributes).toMatchObject({ wakeupId: timer.id });
    }, { timeout: 10_000 });
    expect(await p.engineStore.getWakeup(timer.id)).toMatchObject({ status: "done", cause: "fired" });
    expect(signalsOf(await threadMessages(baseUrl, sessionId, threadId), "process.exited")).toHaveLength(1);

    // Step 10: task { resources: { scratch: "200Gi" } } is refused at the agent cap.
    const sessionsBefore = (await p.db.select({ id: agentSessions.id }).from(agentSessions)).length;
    const spawner = p.childSpawner;
    const refusal = await spawner(
      { prompt: "p", resources: { scratch: "200Gi" } },
      { parentSessionId: sessionId, parentThreadId: threadId, actorUserId: "local-user", owner: session.owner },
    ).then(
      () => null,
      (err: unknown) => err,
    );
    expect(isScratchRequestError(refusal)).toBe(true);
    const a4 =
      "scratch 200Gi exceeds the 100Gi agent cap (sandbox.scratchAgentMax). Declare it in .valet/prebuild.yaml, or ask an admin to raise the cap.";
    expect(refusal).toMatchObject({ message: a4 });

    const taskTool = builtinTools.find((t) => t.name === "task");
    if (!taskTool) throw new Error("no task tool");
    const result = await taskTool.execute(
      { prompt: "p", resources: { scratch: "200Gi" } },
      taskToolContext(session, threadId, spawner),
    );
    expect(result.text).toBe(`[task_resources] ${a4}`);
    expect((await p.db.select({ id: agentSessions.id }).from(agentSessions)).length).toBe(sessionsBefore);
  }, 60_000);
});
