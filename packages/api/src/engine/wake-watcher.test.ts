import { describe, expect, it, vi } from "vitest";
import {
  EVENT_DELIVERED_MAX_KEYS,
  InMemorySessionStore,
  SandboxEvictedError,
  SandboxGoneError,
  SandboxSupersededError,
  SandboxUnavailableError,
} from "@valet/engine";
import type {
  EventMatchDigest,
  ExecResult,
  JobPoll,
  JobPollOpts,
  Lease,
  PromptContent,
  PromptOptions,
  Sandbox,
  Wakeup,
  WakeupCause,
  WakeupKind,
} from "@valet/engine";
import githubPlugin from "@valet/plugin-github/plugin";
import { eventWaiterDeriver, type RunDeriveResult } from "../events/derive.js";
import { WakeWatcher, type WakeWatcherDeps, type WakeWatcherSession } from "./wake-watcher.js";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const LIMITS = { leaseMaxHours: 72, timerMaxHours: 720, perSession: 20, watchMaxEventsPerHour: 120 };

type PollScript = (execId: string, offset: number, opts?: JobPollOpts) => Promise<JobPoll>;

function fakeSandbox(id: string, pollJob: PollScript, cancelJob = vi.fn(async (_execId: string) => {})): Sandbox {
  const unused = async (): Promise<never> => {
    throw new Error("not used by the watcher");
  };
  const exec = async (): Promise<ExecResult> => unused();
  return {
    id,
    readFile: unused,
    readBinary: unused,
    writeFile: unused,
    writeBinary: unused,
    readdir: unused,
    stat: unused,
    mkdir: unused,
    rm: unused,
    exec,
    pollJob: vi.fn(pollJob),
    cancelJob,
  };
}

interface Harness {
  store: InMemorySessionStore;
  threads: Set<string>;
  prompt: ReturnType<typeof vi.fn<(content: PromptContent, opts: PromptOptions) => Promise<unknown>>>;
  restore: ReturnType<typeof vi.fn<(id: string) => Promise<Sandbox>>>;
  setEvictionProtection: ReturnType<typeof vi.fn<(id: string, enabled: boolean) => Promise<{ changed: boolean }>>>;
  listEvictionProtected: ReturnType<typeof vi.fn<() => Promise<string[]>>>;
  cancelJob: ReturnType<typeof vi.fn<(execId: string) => Promise<void>>>;
  sessionFor: ReturnType<typeof vi.fn<(sessionId: string) => Promise<WakeWatcherSession>>>;
  wakeupEnded: ReturnType<typeof vi.fn<(kind: WakeupKind, cause: WakeupCause) => void>>;
  signalLost: ReturnType<typeof vi.fn<(kind: WakeupKind | "hold") => void>>;
  leasesUnannotated: ReturnType<typeof vi.fn<(count: number) => void>>;
  watcher(extra?: Partial<Pick<WakeWatcherDeps, "batchSize" | "metrics" | "jobLogDir" | "sweepIntervalMs" | "deriveEvent" | "now">>): WakeWatcher;
}

function harness(poll: PollScript = async () => ({ status: "running", output: "", nextOffset: 0 })): Harness {
  const store = new InMemorySessionStore();
  const prompt = vi.fn(async (_content: PromptContent, _opts: PromptOptions): Promise<unknown> => ({}));
  const cancelJob = vi.fn(async (_execId: string) => {});
  const restore = vi.fn(async (id: string) => fakeSandbox(id, poll, cancelJob));
  const setEvictionProtection = vi.fn(async (_id: string, _enabled: boolean) => ({ changed: false }));
  const listEvictionProtected = vi.fn(async (): Promise<string[]> => []);
  const threads = new Set(["thread-1"]);
  const session: WakeWatcherSession = {
    prompt,
    threadById: (id) => (threads.has(id) ? { id } : null),
    attachment: { current: () => null },
  };
  const sessionFor = vi.fn(async (_sessionId: string) => session);
  // Injected spies, not a module mock: the unit project runs with
  // isolate: false, so a vi.mock of @valet/engine can miss a wake-watcher
  // module another test file already loaded.
  const wakeupEnded = vi.fn((_kind: WakeupKind, _cause: WakeupCause) => {});
  const signalLost = vi.fn((_kind: WakeupKind | "hold") => {});
  const leasesUnannotated = vi.fn((_count: number) => {});
  const deps: WakeWatcherDeps = {
    engineStore: store,
    engineHost: { sessionFor, liveSession: () => null },
    loadSession: async (sessionId) => sessionFor(sessionId),
    provider: { restore, setEvictionProtection, listEvictionProtected },
    limits: LIMITS,
    metrics: { wakeupEnded, signalLost, leasesUnannotated },
    now: () => NOW,
  };
  return {
    store,
    threads,
    prompt,
    restore,
    setEvictionProtection,
    listEvictionProtected,
    cancelJob,
    sessionFor,
    wakeupEnded,
    signalLost,
    leasesUnannotated,
    watcher: (extra = {}) => new WakeWatcher({ ...deps, ...extra, metrics: { ...deps.metrics, ...extra.metrics } }),
  };
}

function wakeup(overrides: Partial<Wakeup> = {}): Wakeup {
  return {
    id: "wk_a",
    sessionId: "sess-1",
    threadId: "thread-1",
    kind: "process",
    status: "running",
    reason: "long build",
    command: "make build",
    execId: "exec-1",
    leaseId: "ls_a",
    deadlineAt: NOW + HOUR,
    logOffset: 0,
    logTail: "",
    eventCount: 0,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    ...overrides,
  };
}

function lease(overrides: Partial<Lease> = {}): Lease {
  return {
    id: "ls_a",
    sessionId: "sess-1",
    sandboxId: "sb-1",
    ownerKind: "process",
    ownerId: "wk_a",
    reason: "long build",
    createdAt: NOW - 60_000,
    deadlineAt: NOW + HOUR,
    ...overrides,
  };
}

async function seedProcess(store: InMemorySessionStore, w: Partial<Wakeup> = {}, l: Partial<Lease> = {}): Promise<void> {
  await store.createWakeup(wakeup(w));
  await store.createLease(lease(l));
}

function signalOf(call: [PromptContent, PromptOptions] | undefined): { content: PromptContent; opts: PromptOptions } {
  if (!call) throw new Error("expected a prompt call");
  return { content: call[0], opts: call[1] };
}

function attr(content: PromptContent, key: string): string | undefined {
  if (typeof content === "string" || !("kind" in content)) return undefined;
  return content.attributes?.[key];
}

describe("WakeWatcher", () => {
  it("delivers process.exited once and releases the lease when the process exits 0", async () => {
    const h = harness(async () => ({ status: "done", exitCode: 0, output: "ok\n", nextOffset: 3 }));
    await seedProcess(h.store);

    await h.watcher().sweep();

    const row = await h.store.getWakeup("wk_a");
    expect(row).toMatchObject({ status: "done", cause: "exit", exitCode: 0 });
    expect(h.restore).toHaveBeenCalledWith("sb-1");
    expect(await h.store.listActiveLeases("sess-1")).toEqual([]);
    expect(h.prompt).toHaveBeenCalledTimes(1);
    const { content, opts } = signalOf(h.prompt.mock.calls[0]);
    expect(content).toMatchObject({ kind: "signal", signalType: "process.exited", tagName: "wakeup", body: "ok\n" });
    expect(attr(content, "exitCode")).toBe("0");
    expect(opts).toEqual({ threadId: "thread-1", dispatchId: "wakeup:wk_a:terminal", queueMode: "followup" });
  });

  it("records the release cause owner_ended on the lease", async () => {
    const h = harness(async () => ({ status: "done", exitCode: 0, output: "", nextOffset: 0 }));
    await seedProcess(h.store);
    const casSpy = vi.spyOn(h.store, "transitionWakeupAndReleaseLease");
    await h.watcher().sweep();
    expect(casSpy).toHaveBeenCalledWith("wk_a", ["running"], "done", expect.anything(), NOW, "owner_ended");
    expect(await h.store.countActiveLeases("sess-1")).toBe(0);
  });

  it("lets only one of two concurrent watchers win the CAS", async () => {
    const h = harness(async () => ({ status: "done", exitCode: 0, output: "", nextOffset: 0 }));
    await seedProcess(h.store);
    const casSpy = vi.spyOn(h.store, "transitionWakeupAndReleaseLease");

    await Promise.all([h.watcher().sweep(), h.watcher().sweep()]);

    expect(h.prompt).toHaveBeenCalledTimes(1);
    const wins = await Promise.all(casSpy.mock.results.map((r) => r.value));
    expect(wins.filter((w) => w !== null)).toHaveLength(1);
    expect(await h.store.countActiveLeases("sess-1")).toBe(0);
  });

  it("does nothing on a second sweep after the row is terminal", async () => {
    const h = harness(async () => ({ status: "done", exitCode: 0, output: "", nextOffset: 0 }));
    await seedProcess(h.store);
    const w = h.watcher();
    await w.sweep();
    await w.sweep();
    expect(h.prompt).toHaveBeenCalledTimes(1);
  });

  it("kills the group, expires the row, and releases with deadline when the deadline passed", async () => {
    const h = harness(async () => ({ status: "running", output: "", nextOffset: 0 }));
    await seedProcess(h.store, { deadlineAt: NOW - 1 });
    const casSpy = vi.spyOn(h.store, "transitionWakeupAndReleaseLease");

    await h.watcher().sweep();

    expect(h.cancelJob).toHaveBeenCalledWith("exec-1");
    expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "expired", cause: "deadline" });
    expect(await h.store.listActiveLeases("sess-1")).toEqual([]);
    expect(casSpy).toHaveBeenCalledWith("wk_a", ["running"], "expired", expect.anything(), NOW, "deadline");
    const { content } = signalOf(h.prompt.mock.calls[0]);
    expect(attr(content, "cause")).toBe("deadline");
  });

  it("still expires the row when the best-effort kill throws", async () => {
    const h = harness(async () => ({ status: "running", output: "", nextOffset: 0 }));
    h.cancelJob.mockRejectedValueOnce(new Error("kill failed"));
    await seedProcess(h.store, { deadlineAt: NOW - 1 });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await h.watcher().sweep();

    expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "expired" });
    error.mockRestore();
  });

  it("marks the row lost with sandbox_unavailable when pollJob throws SandboxUnavailableError", async () => {
    const h = harness(async () => {
      throw new SandboxUnavailableError();
    });
    await seedProcess(h.store);

    await h.watcher().sweep();

    expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "lost", cause: "sandbox_unavailable" });
    expect(await h.store.countActiveLeases("sess-1")).toBe(0);
    const { content } = signalOf(h.prompt.mock.calls[0]);
    expect(attr(content, "cause")).toBe("sandbox_unavailable");
  });

  it("treats the kubernetes pod-recreated error as unavailable", async () => {
    const h = harness(async () => {
      throw new Error('No such container: sandbox "sb-1" is not running (the job\'s backing pod was recreated or removed)');
    });
    await seedProcess(h.store);
    await h.watcher().sweep();
    expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "lost", cause: "sandbox_unavailable" });
  });

  it("logs and skips a row when pollJob throws an unknown error", async () => {
    const h = harness(async () => {
      throw new Error("transient exec hiccup");
    });
    await seedProcess(h.store);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await h.watcher().sweep();

    expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "running" });
    expect(h.prompt).not.toHaveBeenCalled();
    expect(error.mock.calls.some((c) => String(c[0]).includes("wk_a"))).toBe(true);
    error.mockRestore();
  });

  it("delivers watch.event, advances the offset, and keeps the lease for 3 new lines", async () => {
    const h = harness(async () => ({ status: "running", output: "a\nb\nc\n", nextOffset: 6 }));
    await seedProcess(h.store, { kind: "watch", command: "tail -f log" }, { ownerKind: "watch" });

    await h.watcher().sweep();

    expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "running", logOffset: 6, eventCount: 1, windowCount: 1 });
    expect(await h.store.countActiveLeases("sess-1")).toBe(1);
    const { content, opts } = signalOf(h.prompt.mock.calls[0]);
    expect(content).toMatchObject({ kind: "signal", signalType: "watch.event", body: "a\nb\nc" });
    expect(attr(content, "lineCount")).toBe("3");
    expect(opts.dispatchId).toBe("wakeup:wk_a:event:1");
  });

  it("persists a running process tail without a signal", async () => {
    const h = harness(async () => ({ status: "running", output: "progress\n", nextOffset: 9 }));
    await seedProcess(h.store);
    await h.watcher().sweep();
    expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "running", logOffset: 9, logTail: "progress\n" });
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it("fires a due timer with its prompt and touches no lease", async () => {
    const h = harness();
    await h.store.createWakeup(
      wakeup({ kind: "timer", status: "pending", prompt: "check the deploy", fireAt: NOW - 1, execId: undefined, leaseId: undefined, command: undefined }),
    );

    await h.watcher().sweep();

    expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "done", cause: "fired" });
    expect(h.restore).not.toHaveBeenCalled();
    const { content, opts } = signalOf(h.prompt.mock.calls[0]);
    expect(content).toMatchObject({ kind: "signal", signalType: "timer.fired", body: "check the deploy" });
    expect(opts.threadId).toBe("thread-1");
  });

  it("leaves a timer that is not due alone", async () => {
    const h = harness();
    await h.store.createWakeup(
      wakeup({ kind: "timer", status: "pending", prompt: "later", fireAt: NOW + 60_000, execId: undefined, leaseId: undefined }),
    );
    await h.watcher().sweep();
    expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "pending" });
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it("ends a timer row with no prompt as lost, counts it as a bad row, and continues the tick (fix wave 3, data L6)", async () => {
    const h = harness();
    const badRow = vi.fn();
    await h.store.createWakeup(
      wakeup({ id: "wk_bad", kind: "timer", status: "pending", prompt: undefined, fireAt: NOW - 1, execId: undefined, leaseId: undefined }),
    );
    await h.store.createWakeup(
      wakeup({ id: "wk_ok", kind: "timer", status: "pending", prompt: "ok", fireAt: NOW - 1, execId: undefined, leaseId: undefined }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await h.watcher({ metrics: { badRow } }).sweep();

    expect(await h.store.getWakeup("wk_ok")).toMatchObject({ status: "done" });
    expect(await h.store.getWakeup("wk_bad")).toMatchObject({ status: "lost" });
    expect(badRow).toHaveBeenCalledWith("engine_wakeups");
    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.some((c) => String(c[0]).includes("wk_bad"))).toBe(true);
    error.mockRestore();
  });

  it("delivers on the main thread when the wakeup's thread is gone", async () => {
    const h = harness();
    h.threads.clear();
    await h.store.createWakeup(
      wakeup({ kind: "timer", status: "pending", prompt: "ping", fireAt: NOW - 1, execId: undefined, leaseId: undefined }),
    );

    await h.watcher().sweep();

    expect(h.prompt).toHaveBeenCalledTimes(1);
    const { content, opts } = signalOf(h.prompt.mock.calls[0]);
    expect(opts).toEqual({ dispatchId: "wakeup:wk_a:terminal", queueMode: "followup" });
    // The main thread can have other readers: the body is a notice, not the
    // work's output, and no channel origin rides along (fix wave 4, N3).
    const body = typeof content !== "string" && "body" in content ? content.body : "";
    expect(body).toContain("the thread it ran in is gone");
    expect(body).not.toContain("ping");
    expect(content).not.toHaveProperty("origin");
  });

  it("counts a kill that throws after the terminal CAS (re-review F5)", async () => {
    const h = harness(async () => ({ status: "running", output: "", nextOffset: 0 }));
    h.cancelJob.mockRejectedValue(new Error("exec refused"));
    await seedProcess(h.store, { deadlineAt: NOW - 1 });
    const killFailed = vi.fn((_kind: WakeupKind) => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await h.watcher({ metrics: { killFailed } }).sweep();

    expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "expired", cause: "deadline" });
    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(killFailed).toHaveBeenCalledWith("process");
    error.mockRestore();
  });

  it("logs a delivery failure with the wakeup id and keeps the terminal row", async () => {
    const h = harness();
    h.prompt.mockRejectedValue(new Error("engine down"));
    await h.store.createWakeup(
      wakeup({ kind: "timer", status: "pending", prompt: "ping", fireAt: NOW - 1, execId: undefined, leaseId: undefined }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await h.watcher().sweep();

    expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "done" });
    expect(error.mock.calls.some((c) => String(c[0]).includes("wk_a"))).toBe(true);
    error.mockRestore();
  });

  it("releases a hold lease past its deadline and delivers lease.expired to the main thread", async () => {
    const h = harness();
    await h.store.createLease(lease({ id: "ls_h", ownerKind: "hold", ownerId: undefined, reason: "debug", deadlineAt: NOW - 1 }));
    const releaseSpy = vi.spyOn(h.store, "releaseLease");

    await h.watcher().sweep();

    expect(await h.store.countActiveLeases("sess-1")).toBe(0);
    expect(releaseSpy).toHaveBeenCalledWith("ls_h", "deadline", NOW);
    const { content, opts } = signalOf(h.prompt.mock.calls[0]);
    expect(content).toMatchObject({
      kind: "signal",
      signalType: "lease.expired",
      tagName: "wakeup",
      body: `Hold "debug" expired at ${new Date(NOW - 1).toISOString()}.`,
      attributes: { leaseId: "ls_h", reason: "debug", ownerKind: "hold" },
    });
    expect(opts).toEqual({ dispatchId: "lease:ls_h:expired", queueMode: "followup" });
  });

  it("leaves a hold lease before its deadline active", async () => {
    const h = harness();
    await h.store.createLease(lease({ id: "ls_h", ownerKind: "hold", ownerId: undefined, deadlineAt: NOW + 1 }));
    await h.watcher().sweep();
    expect(await h.store.countActiveLeases("sess-1")).toBe(1);
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it("adopts rows after a restart: a new watcher on the same store finishes the work", async () => {
    let status: JobPoll["status"] = "running";
    const h = harness(async () =>
      status === "running" ? { status, output: "", nextOffset: 0 } : { status, exitCode: 0, output: "", nextOffset: 0 },
    );
    await seedProcess(h.store);
    await h.watcher().sweep();
    expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "running" });

    status = "done";
    await h.watcher().sweep();

    expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "done", cause: "exit" });
    expect(await h.store.countActiveLeases("sess-1")).toBe(0);
    expect(h.prompt).toHaveBeenCalledTimes(1);
  });

  it("probes through the live session's ready sandbox instead of restoring", async () => {
    const h = harness();
    const live = fakeSandbox("sb-1", async () => ({ status: "done", exitCode: 2, output: "", nextOffset: 0 }));
    const prompt = vi.fn(async (_content: PromptContent, _opts: PromptOptions): Promise<unknown> => ({}));
    const liveSession: WakeWatcherSession = { prompt, threadById: (id) => ({ id }), attachment: { current: () => live } };
    await seedProcess(h.store);
    const watcher = new WakeWatcher({
      engineStore: h.store,
      engineHost: { sessionFor: h.sessionFor, liveSession: () => liveSession },
      loadSession: async (id) => h.sessionFor(id),
      provider: { restore: h.restore },
      limits: LIMITS,
      now: () => NOW,
    });

    await watcher.sweep();

    expect(h.restore).not.toHaveBeenCalled();
    expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "done", exitCode: 2 });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it("restores the lease's sandbox when the live session holds a different one", async () => {
    const h = harness(async () => ({ status: "done", exitCode: 0, output: "", nextOffset: 0 }));
    const other = fakeSandbox("sb-other", async () => ({ status: "running", output: "", nextOffset: 0 }));
    const prompt = vi.fn(async (_content: PromptContent, _opts: PromptOptions): Promise<unknown> => ({}));
    const liveSession: WakeWatcherSession = { prompt, threadById: (id) => ({ id }), attachment: { current: () => other } };
    await seedProcess(h.store);
    const watcher = new WakeWatcher({
      engineStore: h.store,
      engineHost: { sessionFor: h.sessionFor, liveSession: () => liveSession },
      loadSession: async (id) => h.sessionFor(id),
      provider: { restore: h.restore },
      limits: LIMITS,
      now: () => NOW,
    });

    await watcher.sweep();

    expect(h.restore).toHaveBeenCalledWith("sb-1");
    expect(other.pollJob).not.toHaveBeenCalled();
    expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "done", exitCode: 0 });
  });

  it("keeps the row due and delivers nothing when the combined CAS and release write throws (B2)", async () => {
    const h = harness(async () => ({ status: "done", exitCode: 0, output: "", nextOffset: 0 }));
    await seedProcess(h.store);
    vi.spyOn(h.store, "transitionWakeupAndReleaseLease").mockRejectedValueOnce(new Error("db blip"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(h.watcher().sweep()).resolves.toBeUndefined();

    expect(h.prompt).not.toHaveBeenCalled();
    expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "running" });
    expect(await h.store.countActiveLeases("sess-1")).toBe(1);
    expect(error.mock.calls.some((c) => String(c[0]).includes("stays due"))).toBe(true);
    error.mockRestore();
  });

  it("protects a leased sandbox and unprotects it after the lease releases", async () => {
    let status: JobPoll["status"] = "running";
    const h = harness(async () =>
      status === "running" ? { status, output: "", nextOffset: 0 } : { status, exitCode: 0, output: "", nextOffset: 0 },
    );
    await seedProcess(h.store);
    const w = h.watcher();

    await w.sweep();
    expect(h.setEvictionProtection).toHaveBeenCalledWith("sb-1", true);
    expect(h.setEvictionProtection).not.toHaveBeenCalledWith("sb-1", false);

    status = "done";
    h.listEvictionProtected.mockResolvedValue(["sb-1"]);
    h.setEvictionProtection.mockClear();
    await w.sweep();

    expect(h.setEvictionProtection).toHaveBeenCalledWith("sb-1", false);
    expect(h.setEvictionProtection).not.toHaveBeenCalledWith("sb-1", true);
  });

  it("runs on providers without eviction protection", async () => {
    const h = harness(async () => ({ status: "running", output: "", nextOffset: 0 }));
    await seedProcess(h.store);
    const watcher = new WakeWatcher({
      engineStore: h.store,
      engineHost: { sessionFor: h.sessionFor, liveSession: () => null },
      loadSession: async (id) => h.sessionFor(id),
      provider: { restore: h.restore },
      limits: LIMITS,
      now: () => NOW,
    });
    await expect(watcher.sweep()).resolves.toBeUndefined();
  });

  describe("fix wave 1: rows never outlive their deadline (C2)", () => {
    it("treats a kubernetes restore miss (CR not found) as unavailable", async () => {
      const h = harness();
      h.restore.mockRejectedValueOnce(new Error('KubernetesSandboxProvider.restore: Sandbox CR "sb-1" not found'));
      await seedProcess(h.store);
      await h.watcher().sweep();
      expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "lost", cause: "sandbox_unavailable" });
      expect(await h.store.countActiveLeases("sess-1")).toBe(0);
    });

    it("treats SandboxSupersededError as unavailable", async () => {
      const h = harness(async () => {
        throw new SandboxSupersededError(2);
      });
      await seedProcess(h.store);
      await h.watcher().sweep();
      expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "lost", cause: "sandbox_unavailable" });
    });

    it("expires a row whose probe keeps failing once its deadline passes", async () => {
      const h = harness(async () => {
        throw new Error("transient exec hiccup");
      });
      await seedProcess(h.store, { deadlineAt: NOW - 1 });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await h.watcher().sweep();
      error.mockRestore();
      expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "expired", cause: "deadline" });
      expect(await h.store.countActiveLeases("sess-1")).toBe(0);
      expect(h.wakeupEnded).toHaveBeenCalledWith("process", "deadline");
    });

    it("ends a row whose lease was released out of band as unavailable", async () => {
      const h = harness();
      await seedProcess(h.store);
      await h.store.releaseLease("ls_a", "owner_ended", NOW - 1);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await h.watcher().sweep();
      warn.mockRestore();
      expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "lost", cause: "sandbox_unavailable" });
      expect(h.restore).not.toHaveBeenCalled();
    });

    it("resolves a lease with no sandbox id from the session row and writes it back", async () => {
      const h = harness(async () => ({ status: "done", exitCode: 0, output: "", nextOffset: 0 }));
      await h.store.saveSession({
        id: "sess-1",
        owner: { type: "user", id: "u1" },
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        purpose: "interactive",
        status: "running",
        sandboxId: "sb-from-row",
        createdAt: 1,
        updatedAt: 1,
      });
      await seedProcess(h.store, {}, { sandboxId: undefined });
      await h.watcher().sweep();
      expect(h.restore).toHaveBeenCalledWith("sb-from-row");
      expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "done", cause: "exit" });
    });

    it("pages past a full batch of always-due rows so a newer timer still fires", async () => {
      const h = harness();
      for (const id of ["wk_1", "wk_2", "wk_3"]) {
        await seedProcess(h.store, { id, leaseId: `ls_${id}`, execId: `exec-${id}`, createdAt: NOW - 90_000 }, { id: `ls_${id}`, ownerId: id });
      }
      await h.store.createWakeup(
        wakeup({ id: "wk_t", kind: "timer", status: "pending", prompt: "ping", fireAt: NOW - 1, createdAt: NOW - 10, execId: undefined, leaseId: undefined, command: undefined }),
      );
      await h.watcher({ batchSize: 2 }).sweep();
      expect(await h.store.getWakeup("wk_t")).toMatchObject({ status: "done", cause: "fired" });
      expect(h.restore).toHaveBeenCalledTimes(3);
    });

    it("reads a process log tail and a watch log in bounded slices (I1)", async () => {
      const seen: Array<JobPollOpts | undefined> = [];
      const h = harness(async (_execId, _offset, opts) => {
        seen.push(opts);
        return { status: "running", output: "", nextOffset: 0 };
      });
      await seedProcess(h.store);
      await seedProcess(h.store, { id: "wk_w", kind: "watch", leaseId: "ls_w", execId: "exec-w" }, { id: "ls_w", ownerKind: "watch", ownerId: "wk_w" });
      await h.watcher().sweep();
      expect(seen).toContainEqual({ maxBytes: 4096, tail: true });
      expect(seen).toContainEqual({ maxBytes: 64 * 1024 });
    });
  });

  describe("fix wave 1: metrics (I7, I8)", () => {
    it("counts a lost signal when delivery fails after the CAS", async () => {
      const h = harness();
      h.prompt.mockRejectedValue(new Error("engine down"));
      await h.store.createWakeup(
        wakeup({ kind: "timer", status: "pending", prompt: "ping", fireAt: NOW - 1, execId: undefined, leaseId: undefined }),
      );
      await h.store.createLease(lease({ id: "ls_h", ownerKind: "hold", ownerId: undefined, deadlineAt: NOW - 1 }));
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await h.watcher().sweep();
      error.mockRestore();
      expect(h.signalLost).toHaveBeenCalledWith("timer");
      expect(h.signalLost).toHaveBeenCalledWith("hold");
    });

    it("counts a failed protection patch as unannotated, but not a lease with no sandbox to protect (M10)", async () => {
      const h = harness();
      h.setEvictionProtection.mockRejectedValue(new Error("pods patch forbidden"));
      await seedProcess(h.store);
      await h.store.createLease(
        lease({ id: "ls_orphan", sessionId: "sess-gone", ownerKind: "hold", ownerId: undefined, sandboxId: undefined, createdAt: NOW - 10 * 60_000 }),
      );
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await h.watcher().sweep();
      error.mockRestore();
      warn.mockRestore();
      expect(h.leasesUnannotated).toHaveBeenLastCalledWith(1);
    });

    it("does not count a fresh lease that has no sandbox id yet", async () => {
      const h = harness();
      await h.store.createLease(lease({ id: "ls_new", ownerKind: "hold", ownerId: undefined, sandboxId: undefined, createdAt: NOW - 1_000 }));
      await h.watcher().sweep();
      expect(h.leasesUnannotated).toHaveBeenLastCalledWith(0);
    });
  });

  describe("fix wave 2", () => {
    it("kills only after a successful CAS (B5 amended, M1)", async () => {
      const order: string[] = [];
      const h = harness(async () => ({ status: "running", output: "", nextOffset: 0 }));
      h.cancelJob.mockImplementation(async () => {
        order.push(`kill:${(await h.store.getWakeup("wk_a"))?.status}`);
      });
      await seedProcess(h.store, { deadlineAt: NOW - 1 });
      await h.watcher().sweep();
      expect(order).toEqual(["kill:expired"]);
    });

    it("kills nothing when another writer wins the CAS first", async () => {
      const h = harness(async () => ({ status: "running", output: "", nextOffset: 0 }));
      await seedProcess(h.store, { deadlineAt: NOW - 1 });
      // An agent cancel lands between the probe and the CAS.
      vi.spyOn(h.store, "transitionWakeupAndReleaseLease").mockResolvedValueOnce(null);
      await h.watcher().sweep();
      expect(h.cancelJob).not.toHaveBeenCalled();
      expect(h.prompt).not.toHaveBeenCalled();
    });

    it("ends a pending process past the start grace, kills its requested id, and releases its lease (B2, H10)", async () => {
      // The probe finds no job for the requested id (fix wave 3: pending rows are probed past the grace).
      const h = harness(async () => ({ status: "failed", output: "", nextOffset: 0 }));
      await seedProcess(h.store, { status: "pending", execId: "job-a-12345678", createdAt: NOW - 45 * 60_000 });
      await seedProcess(h.store, { id: "wk_young", status: "pending", leaseId: "ls_young", execId: "job-b-12345678", createdAt: NOW - 60_000 }, { id: "ls_young", ownerId: "wk_young" });

      await h.watcher().sweep();

      expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "lost", cause: "pid_missing" });
      expect(h.cancelJob).toHaveBeenCalledWith("job-a-12345678");
      expect(await h.store.getWakeup("wk_young")).toMatchObject({ status: "pending" });
      expect((await h.store.listActiveLeases("sess-1")).map((l) => l.id)).toEqual(["ls_young"]);
      expect(attr(signalOf(h.prompt.mock.calls[0]).content, "cause")).toBe("pid_missing");
    });

    it("releases an orphan process lease and counts it, and leaves a live owner's lease alone (B2)", async () => {
      const h = harness();
      const orphanReleased = vi.fn();
      await h.store.createLease(lease({ id: "ls_missing", ownerId: "wk_gone" }));
      await h.store.createWakeup(wakeup({ id: "wk_done", status: "done", cause: "exit", leaseId: "ls_term" }));
      await h.store.createLease(lease({ id: "ls_term", ownerId: "wk_done" }));
      await seedProcess(h.store, { id: "wk_live", leaseId: "ls_live" }, { id: "ls_live", ownerId: "wk_live" });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await h.watcher({ metrics: { orphanReleased } }).sweep();
      warn.mockRestore();

      expect((await h.store.listActiveLeases("sess-1")).map((l) => l.id)).toEqual(["ls_live"]);
      expect(orphanReleased).toHaveBeenCalledTimes(2);
      expect(orphanReleased).toHaveBeenCalledWith("process", "missing_owner");
      expect(orphanReleased).toHaveBeenCalledWith("process", "terminal_owner");
    });

    it("attaches the stored origin with manual replies to every signal (H3)", async () => {
      const h = harness(async () => ({ status: "done", exitCode: 0, output: "", nextOffset: 0 }));
      const origin = { channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" as const };
      await seedProcess(h.store, { origin });
      await h.watcher().sweep();
      expect(signalOf(h.prompt.mock.calls[0]).content).toMatchObject({ origin: { ...origin, reply: "manual" } });
    });

    it("delivers lease.expired to the thread that asked for the hold, with B6 attributes and the origin (M17)", async () => {
      const h = harness();
      h.threads.add("thread-9");
      const origin = { channelType: "slack", threadKey: "slack:C1:9.9" };
      await h.store.createLease(lease({ id: "ls_h", ownerKind: "hold", ownerId: undefined, threadId: "thread-9", origin, reason: "debug", deadlineAt: NOW - 1 }));

      await h.watcher().sweep();

      const { content, opts } = signalOf(h.prompt.mock.calls[0]);
      expect(opts.threadId).toBe("thread-9");
      expect(content).toMatchObject({
        signalType: "lease.expired",
        attributes: { leaseId: "ls_h", reason: "debug", ownerKind: "hold", expiredAt: new Date(NOW).toISOString() },
        origin: { ...origin, reply: "manual" },
      });
    });

    it.each([
      ["SandboxEvictedError", new SandboxEvictedError("Evicted", "ephemeral storage")],
      ["SandboxGoneError", new SandboxGoneError("The recorded Docker container is missing.")],
    ])("treats %s as sandbox gone (M2)", async (_name, err) => {
      const h = harness(async () => {
        throw err;
      });
      await seedProcess(h.store);
      await h.watcher().sweep();
      expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "lost", cause: "sandbox_unavailable" });
    });

    it("sets the active gauge from a store count, so a pending timer that is not due counts (M11)", async () => {
      const h = harness();
      const wakeupsActive = vi.fn();
      await h.store.createWakeup(
        wakeup({ kind: "timer", status: "pending", prompt: "later", fireAt: NOW + HOUR, execId: undefined, leaseId: undefined }),
      );
      await h.watcher({ metrics: { wakeupsActive } }).sweep();
      expect(wakeupsActive).toHaveBeenCalledWith("timer", 1);
      expect(wakeupsActive).toHaveBeenCalledWith("process", 0);
    });

    it("measures node seconds from the real time since the previous pass (M11)", async () => {
      const h = harness();
      const nodeSeconds = vi.fn();
      await h.store.createLease(lease({ id: "ls_h", ownerKind: "hold", ownerId: undefined, createdAt: NOW - 10_000, deadlineAt: NOW + HOUR }));
      const w = h.watcher({ metrics: { nodeSeconds } });
      await w.sweep(NOW);
      await w.sweep(NOW + 95_000);
      expect(nodeSeconds.mock.calls).toEqual([
        ["hold", 10],
        ["hold", 95],
      ]);
    });

    it("records sweep_ok_at after a pass and sweep_failed when a pass throws (M5)", async () => {
      const h = harness();
      const sweepOk = vi.fn();
      const sweepFailed = vi.fn();
      const w = h.watcher({ metrics: { sweepOk, sweepFailed } });
      await w.sweep();
      expect(sweepOk).toHaveBeenCalledWith(Math.floor(NOW / 1000));
      vi.spyOn(h.store, "listDueWakeups").mockRejectedValueOnce(new Error("db down"));
      await expect(w.sweep()).rejects.toThrow("db down");
      expect(sweepFailed).toHaveBeenCalledTimes(1);
    });

    it("names logPath only when the provider writes job log files (L)", async () => {
      const done = async (): Promise<JobPoll> => ({ status: "done", exitCode: 0, output: "", nextOffset: 0 });
      const docker = harness(done);
      await seedProcess(docker.store);
      await docker.watcher().sweep();
      expect(attr(signalOf(docker.prompt.mock.calls[0]).content, "logPath")).toBeUndefined();

      const k8s = harness(done);
      await seedProcess(k8s.store);
      await k8s.watcher({ jobLogDir: "/tmp/valet-jobs" }).sweep();
      expect(attr(signalOf(k8s.prompt.mock.calls[0]).content, "logPath")).toBe("/tmp/valet-jobs/exec-1.out");
    });
  });

  describe("fix wave 3", () => {
    it("measures over_deadline at the start of the pass, before the pass ends the owner (M2)", async () => {
      const h = harness(async () => ({ status: "running", output: "", nextOffset: 0 }));
      const leasesOverDeadline = vi.fn();
      await seedProcess(h.store, { deadlineAt: NOW - 61_000 }, { deadlineAt: NOW - 61_000 });
      await h.watcher({ metrics: { leasesOverDeadline } }).sweep();
      expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "expired", cause: "deadline" });
      expect(leasesOverDeadline).toHaveBeenCalledWith(1);
    });

    it("ends a running owner past its deadline as expired, kills it, and counts reason=deadline (M2, concurrency L5)", async () => {
      const h = harness(async () => ({ status: "running", output: "", nextOffset: 0 }));
      const orphanReleased = vi.fn();
      const wakeupEnded = vi.fn();
      await seedProcess(h.store, { deadlineAt: NOW - 61_000 }, { deadlineAt: NOW - 61_000 });
      // The row's own transition fails this tick, so only the lease repair can end it.
      const real = h.store.transitionWakeupAndReleaseLease.bind(h.store);
      vi.spyOn(h.store, "transitionWakeupAndReleaseLease")
        .mockRejectedValueOnce(new Error("db blip"))
        .mockImplementation(real);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await h.watcher({ metrics: { orphanReleased, wakeupEnded } }).sweep();
      error.mockRestore();
      warn.mockRestore();
      expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "expired", cause: "deadline" });
      expect(await h.store.countActiveLeases("sess-1")).toBe(0);
      expect(h.cancelJob).toHaveBeenCalledWith("exec-1");
      expect(orphanReleased).toHaveBeenCalledWith("process", "deadline");
      expect(wakeupEnded).toHaveBeenCalledWith("process", "deadline");
      expect(attr(signalOf(h.prompt.mock.calls[0]).content, "cause")).toBe("deadline");
    });

    it("counts at most one interval of node seconds for an old lease on the first pass after a restart (data L1)", async () => {
      const h = harness();
      const nodeSeconds = vi.fn();
      await h.store.createLease(lease({ id: "ls_h", ownerKind: "hold", ownerId: undefined, createdAt: NOW - 24 * HOUR, deadlineAt: NOW + HOUR }));
      await h.watcher({ metrics: { nodeSeconds } }).sweep(NOW);
      expect(nodeSeconds.mock.calls).toEqual([["hold", 30]]);
    });

    it("stamps endedAt with the clock at the transition, not the pass start (concurrency M1)", async () => {
      const h = harness(async () => ({ status: "done", exitCode: 0, output: "", nextOffset: 0 }));
      await seedProcess(h.store);
      let t = NOW;
      const w = new WakeWatcher({
        engineStore: h.store,
        engineHost: { sessionFor: h.sessionFor, liveSession: () => null },
        loadSession: async (id) => h.sessionFor(id),
        provider: { restore: h.restore },
        limits: LIMITS,
        now: () => (t += 50_000),
      });
      await w.sweep(NOW);
      const row = await h.store.getWakeup("wk_a");
      expect(row?.endedAt).toBeGreaterThan(NOW);
      expect(row?.updatedAt).toBe(row?.endedAt);
    });

    it("adopts a pending row past the grace when the probe finds its job running (concurrency L6, P9)", async () => {
      const h = harness(async () => ({ status: "running", output: "", nextOffset: 0 }));
      await seedProcess(h.store, { status: "pending", createdAt: NOW - 45 * 60_000 });
      await h.watcher().sweep();
      expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "running" });
      expect(h.cancelJob).not.toHaveBeenCalled();
      expect(h.prompt).not.toHaveBeenCalled();
    });

    it("coalesces watch output with the limits' watchMinIntervalMs (M1)", async () => {
      const h = harness(async () => ({ status: "running", output: "b\n", nextOffset: 4 }));
      await seedProcess(h.store, { kind: "watch", logOffset: 2, eventCount: 1, lastEmitAt: NOW - 1_000 }, { ownerKind: "watch" });
      await h.watcher().sweep();
      expect(h.prompt).not.toHaveBeenCalled();
      expect(await h.store.getWakeup("wk_a")).toMatchObject({ watchBuffer: "b\n", logOffset: 4 });
    });

    it("stops between rows once stop() is called, and stop() waits for the row in flight (concurrency M6)", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const polled: string[] = [];
      const h = harness(async (execId) => {
        polled.push(execId);
        if (execId === "exec-1") await gate;
        return { status: "running", output: "", nextOffset: 0 };
      });
      await seedProcess(h.store);
      await seedProcess(h.store, { id: "wk_b", execId: "exec-2", leaseId: "ls_b", createdAt: NOW }, { id: "ls_b", ownerId: "wk_b" });
      const w = h.watcher({ sweepIntervalMs: 60_000 });
      const pass = w.sweep();
      await vi.waitFor(() => expect(polled).toEqual(["exec-1"]));
      const stopped = w.stop();
      release();
      await pass;
      await stopped;
      expect(polled).toEqual(["exec-1"]);
    });

    it("records sweep_ok_at when it starts, so a watcher that never finishes a pass still has the series (data L3)", async () => {
      const h = harness();
      const sweepOk = vi.fn();
      const w = h.watcher({ metrics: { sweepOk }, sweepIntervalMs: 60_000 });
      w.start();
      expect(sweepOk).toHaveBeenCalledWith(Math.floor(NOW / 1000));
      await w.stop();
    });
  });

  describe("fix wave 4", () => {
    it("pages on the store's cursor, so a page that skipped an unreadable row does not end the pass (data N1)", async () => {
      const h = harness();
      for (const id of ["wk_1", "wk_2", "wk_3"]) {
        await seedProcess(h.store, { id, leaseId: `ls_${id}`, execId: `exec-${id}`, createdAt: NOW - 90_000 }, { id: `ls_${id}`, ownerId: id });
      }
      await h.store.createWakeup(
        wakeup({ id: "wk_t", kind: "timer", status: "pending", prompt: "ping", fireAt: NOW - 1, createdAt: NOW - 10, execId: undefined, leaseId: undefined, command: undefined }),
      );
      const real = h.store.listDueWakeups.bind(h.store);
      // The first page reads two raw rows but one is unreadable, so it maps one.
      vi.spyOn(h.store, "listDueWakeups").mockImplementation(async (now, limit, after) => {
        const page = await real(now, limit, after);
        return after === undefined ? { rows: page.rows.slice(1), next: page.next } : page;
      });
      await h.watcher({ batchSize: 2 }).sweep();
      expect(await h.store.getWakeup("wk_t")).toMatchObject({ status: "done", cause: "fired" });
    });

    it("passes the provider's truncated flag to the exit body (UX N5)", async () => {
      const h = harness(async () => ({ status: "done", exitCode: 0, output: "head\n", nextOffset: 5, truncated: true }));
      await seedProcess(h.store);
      await h.watcher().sweep();
      const { content } = signalOf(h.prompt.mock.calls[0]);
      const body = typeof content === "object" && "body" in content ? String(content.body) : "";
      expect(body).toContain("The log hit its size cap");
    });

    it("delivers the signal before the kill, so a cut shutdown loses the kill, not the signal (concurrency M6)", async () => {
      const order: string[] = [];
      const h = harness(async () => ({ status: "running", output: "", nextOffset: 0 }));
      h.cancelJob.mockImplementation(async () => {
        order.push("kill");
      });
      h.prompt.mockImplementation(async () => {
        order.push("deliver");
        return {};
      });
      await seedProcess(h.store, { deadlineAt: NOW - 1 }, { deadlineAt: NOW - 1 });
      await h.watcher().sweep();
      expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "expired", cause: "deadline" });
      expect(order).toEqual(["deliver", "kill"]);
    });

    it("skips the lease reconcile once stop() is called during the lease pass (concurrency M6)", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = harness();
      h.prompt.mockImplementation(async () => {
        await gate;
        return {};
      });
      await h.store.createLease(lease({ id: "ls_h", ownerKind: "hold", ownerId: undefined, deadlineAt: NOW - 1 }));
      const w = h.watcher({ sweepIntervalMs: 60_000 });
      const pass = w.sweep();
      await vi.waitFor(() => expect(h.prompt).toHaveBeenCalled());
      const stopped = w.stop();
      release();
      await pass;
      await stopped;
      expect(h.listEvictionProtected).not.toHaveBeenCalled();
    });

    it("protects nothing less when one lease lookup fails: it skips the unprotect pass for that tick (k8s N-7)", async () => {
      const h = harness();
      await h.store.saveSession({
        id: "sess-1", userId: "u1", orgId: "o1", owner: { type: "user", id: "u1" }, workspace: "/",
        purpose: "interactive", status: "running", createdAt: 1, updatedAt: 1,
      });
      await h.store.createLease(lease({ id: "ls_h", ownerKind: "hold", ownerId: undefined, sandboxId: undefined, createdAt: NOW - 10 * 60_000 }));
      h.listEvictionProtected.mockResolvedValue(["sb-1"]);
      vi.spyOn(h.store, "getSession").mockRejectedValueOnce(new Error("db blip"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await h.watcher().sweep();
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }
      expect(h.setEvictionProtection).not.toHaveBeenCalledWith("sb-1", false);
    });

    it("counts node seconds once per sandbox when two leases share it (k8s L-4b)", async () => {
      const h = harness();
      const nodeSeconds = vi.fn();
      await h.store.createLease(lease({ id: "ls_p", createdAt: NOW - 10_000 }));
      await h.store.createLease(lease({ id: "ls_h", ownerKind: "hold", ownerId: undefined, createdAt: NOW - 5_000 }));
      await h.store.createLease(lease({ id: "ls_o", sandboxId: "sb-2", ownerKind: "hold", ownerId: undefined, createdAt: NOW - 4_000 }));
      await h.store.createWakeup(wakeup({ leaseId: "ls_p" }));
      const w = h.watcher({ metrics: { nodeSeconds } });
      await w.sweep(NOW);
      expect(nodeSeconds.mock.calls).toEqual([
        ["process", 10],
        ["hold", 4],
      ]);
    });
  });
});

describe("WakeWatcher event waiters (event wakeups spec, Part F)", () => {
  const CHECKS = "github.pull_request.checks_completed";
  const digest = (n: number, over: Partial<EventMatchDigest> = {}): EventMatchDigest => ({
    key: "github.check_run.completed",
    status: "failure",
    subjects: ["github:acme/lean-proofs#42"],
    summary: `acme/lean-proofs: check_run completed (test-${n})`,
    occurredAt: "2026-10-15T00:00:00Z",
    dedupeKey: `d-${n}`,
    ...over,
  });
  const derived: EventMatchDigest = {
    key: CHECKS,
    status: "failure",
    subjects: ["github:acme/lean-proofs#42"],
    summary: "acme/lean-proofs#42: checks completed",
    occurredAt: "2026-10-15T00:00:00Z",
    dedupeKey: "derived:checks_completed:acme/lean-proofs@aaaa:failure",
  };
  const eventRow = (over: Partial<Wakeup> = {}, once = true): Wakeup =>
    wakeup({
      id: "wk_ev",
      kind: "event",
      reason: "CI on #42",
      command: undefined,
      execId: undefined,
      leaseId: undefined,
      deadlineAt: NOW + 6 * HOUR,
      subjects: ["github:acme/lean-proofs#42"],
      eventMatch: { clauses: [{ key: "github.check_run.completed" }, { key: CHECKS }], once, self: [] },
      eventBuffer: [],
      ...over,
    });

  it("delivers a once-mode match as the terminal signal and ends the row as done/fired", async () => {
    const h = harness();
    await h.store.createWakeup(eventRow({ eventBuffer: [digest(1)] }));
    await h.watcher().sweep(NOW);
    const row = await h.store.getWakeup("wk_ev");
    expect(row?.status).toBe("done");
    expect(row?.cause).toBe("fired");
    expect(row?.eventBuffer).toEqual([]);
    expect(h.prompt).toHaveBeenCalledTimes(1);
    const { content, opts } = signalOf(h.prompt.mock.calls[0]);
    expect(opts).toMatchObject({ threadId: "thread-1", dispatchId: "wakeup:wk_ev:terminal" });
    expect(typeof content !== "string" && "body" in content ? content.body : "").toContain("github.check_run.completed · failure");
    expect(h.wakeupEnded).toHaveBeenCalledWith("event", "fired");
    // The row is terminal, so a second pass delivers nothing.
    await h.watcher().sweep(NOW + 1);
    expect(h.prompt).toHaveBeenCalledTimes(1);
  });

  it("ends a once-mode waiter that a claim redirect delivered to with exactly one event.ended signal (Part C step 5)", async () => {
    const h = harness();
    await h.store.createWakeup(eventRow());
    const watcher = h.watcher();
    const target = { waiterId: "wk_ev", sessionId: "sess-1", threadId: "thread-1" };
    expect(await watcher.endDeliveredWaiter(target)).toBe(true);
    const row = await h.store.getWakeup("wk_ev");
    expect(row).toMatchObject({ status: "done", cause: "fired" });
    expect(h.prompt).toHaveBeenCalledTimes(1);
    const { content, opts } = signalOf(h.prompt.mock.calls[0]);
    expect(opts).toMatchObject({ threadId: "thread-1", dispatchId: "wakeup:wk_ev:terminal", queueMode: "followup" });
    expect(content).toMatchObject({ signalType: "event.ended", attributes: { cause: "delivered" } });
    expect(h.wakeupEnded).toHaveBeenCalledWith("event", "fired");
    // A retried delivery and a later sweep send no second terminal signal (INV-E5).
    expect(await watcher.endDeliveredWaiter(target)).toBe(false);
    await watcher.sweep(NOW + 1);
    expect(h.prompt).toHaveBeenCalledTimes(1);
  });

  it("puts a digest that arrived meanwhile in the one terminal event.matched signal", async () => {
    const h = harness();
    await h.store.createWakeup(eventRow({ eventBuffer: [digest(1)] }));
    expect(await h.watcher().endDeliveredWaiter({ waiterId: "wk_ev", sessionId: "sess-1", threadId: "thread-1" })).toBe(true);
    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(signalOf(h.prompt.mock.calls[0]).content).toMatchObject({ signalType: "event.matched" });
  });

  it("leaves a stream waiter, or a waiter of another thread, running", async () => {
    const h = harness();
    await h.store.createWakeup(eventRow({}, false));
    const watcher = h.watcher();
    expect(await watcher.endDeliveredWaiter({ waiterId: "wk_ev", sessionId: "sess-1", threadId: "thread-1" })).toBe(false);
    await h.store.createWakeup(eventRow({ id: "wk_once" }));
    expect(await watcher.endDeliveredWaiter({ waiterId: "wk_once", sessionId: "sess-1", threadId: "thread-2" })).toBe(false);
    expect(await watcher.endDeliveredWaiter({ waiterId: "wk_missing", sessionId: "sess-1", threadId: "thread-1" })).toBe(false);
    expect((await h.store.getWakeup("wk_ev"))?.status).toBe("running");
    expect((await h.store.getWakeup("wk_once"))?.status).toBe("running");
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it("removes only the delivered digests in stream mode, so a digest appended meanwhile stays", async () => {
    const h = harness();
    await h.store.createWakeup(eventRow({ eventBuffer: [digest(1), digest(2)] }, false));
    const transition = h.store.transitionWakeup.bind(h.store);
    vi.spyOn(h.store, "transitionWakeup").mockImplementation(async (...args) => {
      // Ingest appends after the watcher read the row, before its CAS.
      await h.store.appendEventMatch("wk_ev", digest(3), NOW);
      return transition(...args);
    });
    await h.watcher().sweep(NOW);
    const row = await h.store.getWakeup("wk_ev");
    expect(row?.status).toBe("running");
    expect(row?.eventCount).toBe(1);
    expect(row?.eventBuffer?.map((d) => d.dedupeKey)).toEqual(["d-3"]);
    expect(row?.eventSeen).toEqual(["d-1", "d-2"]);
    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(signalOf(h.prompt.mock.calls[0]).opts.dispatchId).toBe("wakeup:wk_ev:event:1");
    expect(h.wakeupEnded).not.toHaveBeenCalled();
  });

  it("keeps a delivered completion deduped after 257 discarded sources", async () => {
    const h = harness();
    await h.store.createWakeup(eventRow({ eventBuffer: [{ ...derived, head_sha: "a".repeat(40) }] }, false));
    const logs = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const w = h.watcher({ deriveEvent: async () => ({ result: "null" }) });
    try {
      await w.sweep(NOW);
      const { content } = signalOf(h.prompt.mock.calls[0]);
      expect(content).toMatchObject({ attributes: { digests: expect.stringContaining(`"head_sha":"${"a".repeat(40)}"`) } });
      for (let i = 0; i < 257; i++) {
        await h.store.appendEventMatch("wk_ev", digest(i, { dedupeKey: `source-${i}`, derive: CHECKS }), NOW);
        await w.sweep(NOW);
      }
      expect(await h.store.appendEventMatch("wk_ev", derived, NOW)).toBe(false);
      expect(h.prompt).toHaveBeenCalledTimes(1);
      expect(logs).toHaveBeenCalledWith("WakeWatcher: event waiter derivation", expect.objectContaining({ result: "null", sourceDedupeKey: "source-256" }));
    } finally { logs.mockRestore(); }
  });

  it("ends a stream at the output cap with one corrective signal, log, and metric", async () => {
    const h = harness();
    await h.store.createWakeup(eventRow({ eventSeen: Array.from({ length: EVENT_DELIVERED_MAX_KEYS - 1 }, (_, i) => `seen-${i}`), eventBuffer: [digest(1)] }, false));
    const logs = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const w = h.watcher();
      await w.sweep(NOW);
      await w.sweep(NOW + 1);
      await w.sweep(NOW + 2);
      expect((await h.store.getWakeup("wk_ev"))).toMatchObject({ status: "done", cause: "output_cap" });
      expect(h.prompt).toHaveBeenCalledTimes(2);
      const { content } = signalOf(h.prompt.mock.calls[1]);
      expect(content).toMatchObject({ signalType: "event.ended", attributes: { cause: "output_cap" }, body: expect.stringContaining("Re-arm a new wait") });
      expect(logs).toHaveBeenCalledWith("WakeWatcher: event output limit reached; re-arm a new wait", { waiterId: "wk_ev" });
      expect(logs).toHaveBeenCalledTimes(1);
      expect(h.wakeupEnded).toHaveBeenCalledExactlyOnceWith("event", "output_cap");
    } finally { logs.mockRestore(); }
  });

  it("keeps the head commit's Retry-After deadline when another commit derives null", async () => {
    const h = harness();
    const head = "aaaa000000000000000000000000000000000001";
    const other = "bbbb000000000000000000000000000000000002";
    const source = (n: number, sha: string) => digest(n, {
      derive: CHECKS, subjects: ["github:acme/lean-proofs#42", `github:acme/lean-proofs@${sha}`],
    });
    await h.store.createWakeup(eventRow({ eventBuffer: [source(1, head), source(2, other)] }));
    let now = NOW;
    let releaseOther = () => {};
    const headLimited = new Promise<void>((resolve) => { releaseOther = resolve; });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { releaseOther(); });
    const checkReads = vi.fn();
    let pullReads = 0;
    const http: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith("/pulls/42")) {
        if (++pullReads === 2) await headLimited; // Complete null only after the head's cooldown is stored.
        return Response.json({ number: 42, head: { sha: head } });
      }
      if (url.pathname.endsWith(`/commits/${head}/check-runs`)) {
        checkReads();
        return Response.json({ message: "rate limited" }, { status: 429, headers: { "Retry-After": "3600" } });
      }
      throw new Error(`Unexpected GitHub read: ${url.pathname}`);
    };
    const record = vi.fn();
    const deriveEvent = eventWaiterDeriver({
      plugins: [githubPlugin], sessionOrg: async () => "org-1",
      contextFor: () => ({ orgId: "org-1", appToken: async () => "test-token", fetch: http, rateLimitKey: async () => "github:installation:77" }), record, now: () => now,
    });
    try {
      const w = h.watcher({ deriveEvent, now: () => now });
      await w.sweep(now);
      expect(record).toHaveBeenCalledWith(CHECKS, "error");
      expect(record).toHaveBeenCalledWith(CHECKS, "null");
      expect(checkReads).toHaveBeenCalledTimes(1);
      expect((await h.store.getWakeup("wk_ev"))?.eventBuffer?.map((d) => d.dedupeKey)).toEqual(["d-1"]);
      now += 10_000;
      await w.sweep(now);
      now = NOW + HOUR - 1;
      await w.sweep(now);
      expect(checkReads).toHaveBeenCalledTimes(1);
      now++;
      await w.sweep(now);
      expect(checkReads).toHaveBeenCalledTimes(2);
    } finally { warn.mockRestore(); }
  });

  it("collapses persistent failures and rechecks stale commits immediately when a new head arrives", async () => {
    const h = harness();
    let now = NOW;
    let current = "aaaa";
    const source = (i: number, sha: string) => digest(i, { derive: CHECKS, subjects: [`github:acme/lean-proofs@${sha}`] });
    await h.store.createWakeup(eventRow({}, false));
    await h.store.appendEventMatch("wk_ev", source(1, current), now);
    const derive = vi.fn(async (_row: Wakeup, d: EventMatchDigest): Promise<RunDeriveResult> =>
      d.subjects.includes(`github:acme/lean-proofs@${current}`) ? { result: "error", error: new Error("GitHub 502") } : { result: "null" });
    const w = h.watcher({ deriveEvent: derive, now: () => now });
    await w.sweep(now);
    for (let i = 2; i < 252; i++) {
      expect(await h.store.appendEventMatch("wk_ev", source(i, current), ++now)).toBe(true);
      await w.sweep(now);
    }
    expect(derive).toHaveBeenCalledTimes(1);
    expect((await h.store.getWakeup("wk_ev"))?.eventBuffer).toHaveLength(1);
    expect(await h.store.appendEventMatch("wk_ev", digest(300), now)).toBe(true);
    current = "bbbb";
    expect(await h.store.appendEventMatch("wk_ev", source(301, current), now)).toBe(true);
    await w.sweep(now);
    expect(derive).toHaveBeenCalledTimes(3);
    expect((await h.store.getWakeup("wk_ev"))?.eventBuffer?.map((d) => d.dedupeKey)).toEqual(["d-301"]);
    expect(h.prompt).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 403, body: "rate limit", headers: { "Retry-After": "3600" } },
    { status: 429, body: "too many requests", headers: {} },
    { status: 403, body: "secondary rate limit", headers: {} },
    { status: 503, body: "retry later", headers: { "Retry-After": "3600" } },
    { status: 401, body: "retry later", headers: { "Retry-After": "3600" } },
  ])("shares installation-wide cooldowns across groups, waiters, and repositories ($status $body)", async ({ status, body, headers }) => {
    const h = harness();
    let now = NOW;
    let limited = true;
    const source = (i: number, repo: string, sha: string) => digest(i, { derive: CHECKS, subjects: [`github:acme/${repo}@${sha}`] });
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (limited) return new Response(body, { status, headers: headers["Retry-After"] ? { "Retry-After": headers["Retry-After"] } : {} });
      if (url.pathname.endsWith("/pulls/42")) return Response.json({ head: { sha: "bbbb" } });
      if (url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: [] });
      if (url.pathname.endsWith("/actions/runs")) return Response.json({ workflow_runs: [] });
      if (url.pathname.endsWith("/status")) return Response.json({ statuses: [] });
      throw new Error(`Unexpected GitHub read: ${url.pathname}`);
    });
    const deriveEvent = eventWaiterDeriver({
      plugins: [githubPlugin], sessionOrg: async () => "org-1", now: () => now,
      contextFor: (orgId, _key, subject) => ({ orgId, appToken: async () => "test-token", fetch: request,
        rateLimitKey: async () => subject.includes("isolated") ? "github:installation:88" : "github:installation:77" }),
    });
    await h.store.createWakeup(eventRow({ eventBuffer: [source(1, "lean-proofs", "aaaa")] }, false));
    const w = h.watcher({ deriveEvent, now: () => now });
    await w.sweep(now);
    expect(request).toHaveBeenCalledTimes(1);
    // A new SHA bypasses generic backoff, but not the shared installation deadline.
    await h.store.appendEventMatch("wk_ev", source(2, "lean-proofs", "bbbb"), now);
    await h.store.createWakeup(eventRow({ id: "wk_second", subjects: ["github:acme/second#42"], eventBuffer: [source(3, "second", "bbbb")] }, false));
    now += 1;
    await w.sweep(now);
    expect(request).toHaveBeenCalledTimes(1);
    await h.store.createWakeup(eventRow({ id: "wk_isolated", subjects: ["github:acme/isolated#42"], eventBuffer: [source(4, "isolated", "bbbb")] }, false));
    limited = false;
    await w.sweep(now);
    expect(request).toHaveBeenCalledTimes(5); // Other installation reads head, checks, workflows, statuses.
    now = NOW + ("Retry-After" in headers ? HOUR : 60_000) - 1;
    await w.sweep(now);
    expect(request).toHaveBeenCalledTimes(5);
    now++;
    await w.sweep(now);
    expect(request.mock.calls.some(([input]) => String(input).includes("/repos/acme/second/pulls/42"))).toBe(true);
    expect((await h.store.getWakeup("wk_ev"))?.eventBuffer).toEqual([]);
    expect((await h.store.getWakeup("wk_second"))?.eventBuffer).toEqual([]);
  });

  it("stops an in-flight group before its next request when another group hits an installation limit", async () => {
    const h = harness();
    let release = () => {};
    const limited = new Promise<void>((resolve) => { release = resolve; });
    let heads = 0;
    const checkReads = vi.fn();
    const http: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith("/pulls/42")) {
        if (++heads === 2) await limited;
        return Response.json({ head: { sha: "aaaa" } });
      }
      checkReads();
      return new Response("secondary rate limit", { status: 403 });
    };
    const deriveEvent = eventWaiterDeriver({ plugins: [githubPlugin], sessionOrg: async () => "org-1",
      contextFor: (orgId) => ({ orgId, appToken: async () => "token", fetch: http,
        rateLimitKey: async () => "github:installation:77", rateLimited: release }),
    });
    const source = (i: number) => digest(i, { derive: CHECKS, subjects: ["github:acme/lean-proofs@aaaa"] });
    await h.store.createWakeup(eventRow({ eventBuffer: [source(1)] }, false));
    await h.store.createWakeup(eventRow({ id: "wk_second", eventBuffer: [source(2)] }, false));
    await h.watcher({ deriveEvent }).sweep(NOW);
    expect(heads).toBe(2);
    expect(checkReads).toHaveBeenCalledTimes(1);
    expect((await h.store.getWakeup("wk_ev"))?.eventBuffer).toHaveLength(1);
    expect((await h.store.getWakeup("wk_second"))?.eventBuffer).toHaveLength(1);
  });

  it("retains rate-limited sources and retries only after the cooldown", async () => {
    const h = harness();
    let now = NOW;
    await h.store.createWakeup(eventRow({ eventBuffer: [digest(1, { derive: CHECKS })] }));
    const derive = vi.fn(async () => ({ result: "error" as const, error: new Error("secondary rate limit"), retryAfterMs: 60_000 }));
    const w = h.watcher({ deriveEvent: derive, now: () => now });
    await w.sweep(now);
    now += 10_000;
    await w.sweep(now);
    expect(derive).toHaveBeenCalledTimes(1);
    expect((await h.store.getWakeup("wk_ev"))?.eventBuffer).toHaveLength(1);
    now += 50_000;
    await w.sweep(now);
    expect(derive).toHaveBeenCalledTimes(2);
  });

  it("backs off exponentially to 15 minutes", async () => {
    const h = harness();
    let now = NOW;
    await h.store.createWakeup(eventRow({ deadlineAt: NOW + 24 * HOUR, eventBuffer: [digest(1, { derive: CHECKS })] }));
    const derive = vi.fn(async () => ({ result: "error" as const, error: new Error("limit"), retryAfterMs: 60_000 }));
    const w = h.watcher({ deriveEvent: derive, now: () => now });
    await w.sweep(now);
    let calls = 1;
    for (const delay of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
      now += delay - 1;
      await w.sweep(now);
      expect(derive).toHaveBeenCalledTimes(calls);
      now += 1;
      await w.sweep(now);
      expect(derive).toHaveBeenCalledTimes(++calls);
    }
  });

  it("honors a provider reset longer than the exponential cap", async () => {
    const h = harness();
    let now = NOW;
    await h.store.createWakeup(eventRow({ deadlineAt: NOW + 24 * HOUR, eventBuffer: [digest(1, { derive: CHECKS })] }));
    const derive = vi.fn(async () => ({ result: "error" as const, error: new Error("primary limit"), retryAfterMs: HOUR }));
    const w = h.watcher({ deriveEvent: derive, now: () => now });
    await w.sweep(now);
    now += HOUR - 1;
    await w.sweep(now);
    expect(derive).toHaveBeenCalledTimes(1);
    now++;
    await w.sweep(now);
    expect(derive).toHaveBeenCalledTimes(2);
  });

  it.each(["5xx", "timeout", "invalid payload", "too many pages"])("backs off every unconsumed %s derive error", async (failure) => {
    const h = harness();
    const head = "aaaa000000000000000000000000000000000001";
    await h.store.createWakeup(eventRow({ eventBuffer: [digest(1, { derive: CHECKS, subjects: ["github:acme/lean-proofs#42", `github:acme/lean-proofs@${head}`] })] }));
    let now = NOW;
    const attempts = vi.fn();
    const http: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith("/pulls/42")) { attempts(); return Response.json({ number: 42, head: { sha: head } }); }
      if (url.pathname.endsWith("/check-runs")) {
        if (failure === "5xx") return new Response("unavailable", { status: 503 });
        if (failure === "timeout") throw new DOMException("Request timed out", "TimeoutError");
        return Response.json({ total_count: 1, check_runs: [{ id: 1, name: "test", app: { id: 2, slug: "ci" }, check_suite: { id: 1 }, status: "completed", conclusion: "success" }] });
      }
      if (url.pathname.endsWith("/actions/runs")) return Response.json({ workflow_runs: [] });
      if (url.pathname.endsWith("/check-suites")) return Response.json(failure === "invalid payload" ? {} : { check_suites: [] });
      if (url.pathname.endsWith("/status")) return Response.json({ statuses: Array.from({ length: 100 }, () => ({ state: "success" })) });
      throw new Error(`Unexpected read: ${url.pathname}`);
    };
    const record = vi.fn();
    const deriveEvent = eventWaiterDeriver({ plugins: [githubPlugin], sessionOrg: async () => "org-1", contextFor: () => ({ orgId: "org-1", appToken: async () => "test-token", fetch: http }), record });
    const w = h.watcher({ deriveEvent, now: () => now });
    await w.sweep(now);
    let calls = 1;
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 512_000, 900_000, 900_000]) {
      await w.sweep(now); // A repeat pass at the same time must not probe again.
      now += delay - 1;
      await w.sweep(now);
      expect(attempts).toHaveBeenCalledTimes(calls);
      now++;
      await w.sweep(now);
      expect(attempts).toHaveBeenCalledTimes(++calls);
    }
    expect(record.mock.calls.every((call) => call[1] === "error")).toBe(true);
    expect((await h.store.getWakeup("wk_ev"))?.eventBuffer).toHaveLength(1);
  });

  it("consumes permission-denied sources and logs error without retrying the next tick", async () => {
    const h = harness();
    await h.store.createWakeup(eventRow({ eventBuffer: [digest(1, { derive: CHECKS })] }));
    const derive = vi.fn(async () => ({ result: "error" as const, error: new Error("403"), consumeSource: true }));
    const logs = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const w = h.watcher({ deriveEvent: derive });
      await w.sweep(NOW);
      await w.sweep(NOW + 10_000);
      expect(derive).toHaveBeenCalledTimes(1);
      expect((await h.store.getWakeup("wk_ev"))?.eventBuffer).toEqual([]);
      expect((await h.store.getWakeup("wk_ev"))?.eventSourceSeen).toEqual(["d-1"]);
      expect(logs).toHaveBeenCalledWith("WakeWatcher: event waiter derivation", expect.objectContaining({ result: "error", sourceDedupeKey: "d-1" }));
    } finally { logs.mockRestore(); }
  });

  it.each(["event", "null", "error"] as const)("logs the %s derivation outcome with its source key", async (result) => {
    const h = harness();
    await h.store.createWakeup(eventRow({ eventBuffer: [digest(1, { derive: CHECKS })] }));
    const logs = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await h.watcher({ deriveEvent: async () => result === "event" ? { result, digest: derived } : result === "null" ? { result } : { result, error: new Error("network") } }).sweep(NOW);
      expect(logs).toHaveBeenCalledWith("WakeWatcher: event waiter derivation", expect.objectContaining({ result, sourceDedupeKey: "d-1", waiterId: "wk_ev" }));
    } finally { logs.mockRestore(); }
  });

  it("holds a stream-mode digest inside the min interval and sends it after", async () => {
    const h = harness();
    await h.store.createWakeup(eventRow({ eventBuffer: [digest(2)], eventCount: 1, lastEmitAt: NOW - 60_000 }, false));
    await h.watcher().sweep(NOW);
    expect(h.prompt).not.toHaveBeenCalled();
    expect((await h.store.getWakeup("wk_ev"))?.eventBuffer).toHaveLength(1);
    await h.watcher().sweep(NOW + 60_000);
    expect(signalOf(h.prompt.mock.calls[0]).opts.dispatchId).toBe("wakeup:wk_ev:event:2");
    expect((await h.store.getWakeup("wk_ev"))?.eventBuffer).toEqual([]);
  });

  it("expires a waiter past its deadline with event.ended", async () => {
    const h = harness();
    await h.store.createWakeup(eventRow({ deadlineAt: NOW - 1, createdAt: NOW - 6 * HOUR }));
    await h.watcher().sweep(NOW);
    const row = await h.store.getWakeup("wk_ev");
    expect(row?.status).toBe("expired");
    expect(row?.cause).toBe("deadline");
    const { content } = signalOf(h.prompt.mock.calls[0]);
    expect(typeof content !== "string" && "signalType" in content ? content.signalType : "").toBe("event.ended");
    expect(h.wakeupEnded).toHaveBeenCalledWith("event", "deadline");
  });

  it("replaces a derive digest with the derived digest, then delivers it", async () => {
    const h = harness();
    const source = digest(1, { derive: CHECKS });
    await h.store.createWakeup(eventRow({ eventBuffer: [source] }));
    const deriveEvent = vi.fn(async (_row: Wakeup, _d: EventMatchDigest): Promise<RunDeriveResult> => ({ result: "event", digest: derived }));
    await h.watcher({ deriveEvent }).sweep(NOW);
    expect(deriveEvent).toHaveBeenCalledTimes(1);
    expect(deriveEvent.mock.calls[0]?.[1]).toEqual(source);
    const row = await h.store.getWakeup("wk_ev");
    expect(row?.status).toBe("done");
    const { content } = signalOf(h.prompt.mock.calls[0]);
    expect(typeof content !== "string" && "body" in content ? content.body : "").toContain(`${CHECKS} · failure`);
  });

  it("derives only the latest source digest per tick and drops the older ones it supersedes", async () => {
    const h = harness();
    await h.store.createWakeup(eventRow({ eventBuffer: [digest(1, { derive: CHECKS }), digest(2, { derive: CHECKS })] }, false));
    const deriveEvent = vi.fn(async (): Promise<RunDeriveResult> => ({ result: "null" }));
    await h.watcher({ deriveEvent }).sweep(NOW);
    expect(deriveEvent).toHaveBeenCalledTimes(1);
    expect(deriveEvent.mock.calls[0]).toEqual([expect.objectContaining({ id: "wk_ev" }), expect.objectContaining({ dedupeKey: "d-2" })]);
    const row = await h.store.getWakeup("wk_ev");
    expect(row?.status).toBe("running");
    expect(row?.eventBuffer).toEqual([]);
    expect(h.prompt).not.toHaveBeenCalled();
  });

  describe("one derive per source commit (re-review: repo-indexed waiters)", () => {
    const HEAD = "github:acme/lean-proofs@aaaa";
    const FOREIGN = "github:acme/lean-proofs@bbbb";
    const source = (n: number, commit: string) =>
      digest(n, { derive: CHECKS, subjects: ["github:acme/lean-proofs", commit], dedupeKey: `derive:${CHECKS}:d-${n}` });

    it("still fires for the head commit when a newer source names another pull request's commit", async () => {
      const h = harness();
      await h.store.createWakeup(eventRow({ eventBuffer: [source(1, HEAD), source(2, FOREIGN)] }));
      const deriveEvent = vi.fn(async (_row: Wakeup, d: EventMatchDigest): Promise<RunDeriveResult> =>
        d.subjects.includes(HEAD) ? { result: "event", digest: derived } : { result: "null" });
      await h.watcher({ deriveEvent }).sweep(NOW);
      expect(deriveEvent).toHaveBeenCalledTimes(2);
      expect((await h.store.getWakeup("wk_ev"))?.status).toBe("done");
      expect(h.prompt).toHaveBeenCalledTimes(1);
      const { content } = signalOf(h.prompt.mock.calls[0]);
      expect(typeof content !== "string" && "body" in content ? content.body : "").toContain(`${CHECKS} · failure`);
    });

    it("a null for the foreign commit removes only that commit's digests, and an error keeps the head's", async () => {
      const h = harness();
      await h.store.createWakeup(eventRow({ eventBuffer: [source(1, HEAD), source(2, FOREIGN), source(3, FOREIGN)] }, false));
      const deriveEvent = vi.fn(async (_row: Wakeup, d: EventMatchDigest): Promise<RunDeriveResult> =>
        d.subjects.includes(HEAD) ? { result: "error", error: new Error("GitHub 502") } : { result: "null" });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await h.watcher({ deriveEvent }).sweep(NOW);
      warn.mockRestore();
      // One call per commit, each for that commit's latest digest.
      expect(deriveEvent.mock.calls.map((c) => c[1].dedupeKey).sort()).toEqual([`derive:${CHECKS}:d-1`, `derive:${CHECKS}:d-3`]);
      const row = await h.store.getWakeup("wk_ev");
      expect(row?.eventBuffer?.map((d) => d.dedupeKey)).toEqual([`derive:${CHECKS}:d-1`]);
      expect(row?.eventSourceSeen).toEqual([`derive:${CHECKS}:d-2`, `derive:${CHECKS}:d-3`]);
      expect(h.prompt).not.toHaveBeenCalled();
    });
  });

  it("drops a digest whose derive returns null and sends no signal", async () => {
    const h = harness();
    await h.store.createWakeup(eventRow({ eventBuffer: [digest(1, { derive: CHECKS })] }));
    await h.watcher({ deriveEvent: async () => ({ result: "null" }) }).sweep(NOW);
    const row = await h.store.getWakeup("wk_ev");
    expect(row?.status).toBe("running");
    expect(row?.eventBuffer).toEqual([]);
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it("keeps a digest whose derive fails, records result=error once, and sends no signal (Review Focus 4)", async () => {
    const h = harness();
    await h.store.createWakeup(eventRow({ eventBuffer: [digest(1, { derive: CHECKS })] }));
    const record = vi.fn();
    const deriveEvent = eventWaiterDeriver({
      plugins: [
        {
          name: "github",
          version: "1.0.0",
          derivedEvents: [
            {
              key: CHECKS,
              description: "all checks done",
              sources: ["github.check_run.completed"],
              derive: async () => {
                throw new Error("GitHub returned 502");
              },
            },
          ],
        },
      ],
      sessionOrg: async () => "org-1",
      contextFor: (orgId) => ({ orgId, appToken: async () => "tok", fetch }),
      record,
    });
    await h.watcher({ deriveEvent }).sweep(NOW);
    expect(record.mock.calls).toEqual([[CHECKS, "error"]]);
    expect((await h.store.getWakeup("wk_ev"))?.eventBuffer?.map((d) => d.dedupeKey)).toEqual(["d-1"]);
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it("treats a derive past its deadline as an error and keeps the digest", async () => {
    vi.useFakeTimers();
    try {
      const record = vi.fn();
      const deriveEvent = eventWaiterDeriver({
        plugins: [
          {
            name: "github",
            version: "1.0.0",
            derivedEvents: [{ key: CHECKS, description: "d", sources: ["github.check_run.completed"], derive: () => new Promise(() => {}) }],
          },
        ],
        sessionOrg: async () => "org-1",
        contextFor: (orgId) => ({ orgId, appToken: async () => "tok", fetch }),
        record,
        deadlineMs: 20_000,
      });
      const pending = deriveEvent(eventRow(), digest(1, { derive: CHECKS }));
      await vi.advanceTimersByTimeAsync(20_000);
      expect((await pending).result).toBe("error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not derive when the waiter's session is gone", async () => {
    const derive = vi.fn(async () => null);
    const deriveEvent = eventWaiterDeriver({
      plugins: [{ name: "github", version: "1.0.0", derivedEvents: [{ key: CHECKS, description: "d", sources: ["github.check_run.completed"], derive }] }],
      sessionOrg: async () => null,
      contextFor: (orgId) => ({ orgId, appToken: async () => "tok", fetch }),
      record: vi.fn(),
    });
    expect((await deriveEvent(eventRow(), digest(1, { derive: CHECKS }))).result).toBe("error");
    expect(derive).not.toHaveBeenCalled();
  });

  it("runs exactly one more light pass after it when nudge() arrives during a running pass", async () => {
    const h = harness();
    const releases: Array<() => void> = [];
    const get = h.store.getWakeup.bind(h.store);
    const spy = vi.spyOn(h.store, "getWakeup").mockImplementation(async (id) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return get(id);
    });
    const due = vi.spyOn(h.store, "listDueWakeups");
    const watcher = h.watcher({ sweepIntervalMs: HOUR });
    watcher.start();
    watcher.nudge(["wk_ev"]);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    watcher.nudge(["wk_ev"]);
    watcher.nudge(["wk_ev"]);
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(spy).toHaveBeenCalledTimes(2);
    releases.shift()?.();
    await watcher.stop();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(due).not.toHaveBeenCalled();
  });

  it("delivers a nudged waiter's digest with no due-row scan, probe, or lease work (final review, item 5)", async () => {
    const h = harness();
    await seedProcess(h.store);
    await h.store.createWakeup(eventRow({ eventBuffer: [digest(1)] }));
    const due = vi.spyOn(h.store, "listDueWakeups");
    const leases = vi.spyOn(h.store, "listAllActiveLeases");
    const watcher = h.watcher({ sweepIntervalMs: HOUR });
    watcher.start();
    watcher.nudge(["wk_ev"]);
    await vi.waitFor(() => expect(h.prompt).toHaveBeenCalledTimes(1));
    await watcher.stop();
    expect((await h.store.getWakeup("wk_ev"))?.status).toBe("done");
    expect(due).not.toHaveBeenCalled();
    expect(leases).not.toHaveBeenCalled();
    expect(h.restore).not.toHaveBeenCalled();
    expect(h.setEvictionProtection).not.toHaveBeenCalled();
    // The process row was not touched.
    expect((await h.store.getWakeup("wk_a"))?.status).toBe("running");
  });

  it("runs derive steps four at a time, so 8 slow derives take about two derive times (final review, item 5)", async () => {
    const h = harness();
    for (let i = 0; i < 8; i++) {
      await h.store.createWakeup(eventRow({ id: `wk_ev${i}`, createdAt: NOW - 60_000 + i, eventBuffer: [digest(i, { derive: CHECKS })] }));
    }
    const DERIVE_MS = 150;
    let running = 0;
    let maxRunning = 0;
    const deriveEvent = vi.fn(async (): Promise<RunDeriveResult> => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, DERIVE_MS));
      running--;
      return { result: "null" };
    });
    const started = Date.now();
    await h.watcher({ deriveEvent }).sweep(NOW);
    const elapsed = Date.now() - started;
    expect(deriveEvent).toHaveBeenCalledTimes(8);
    expect(maxRunning).toBe(4);
    expect(elapsed).toBeLessThan(4 * DERIVE_MS);
  });

  it("processes process rows before event rows, so a slow derive does not hold them up", async () => {
    const order: string[] = [];
    const h = harness(async () => {
      order.push("poll");
      return { status: "running", output: "", nextOffset: 0 };
    });
    await h.store.createWakeup(eventRow({ createdAt: NOW - 120_000, eventBuffer: [digest(1, { derive: CHECKS })] }));
    await seedProcess(h.store);
    const deriveEvent = async (): Promise<RunDeriveResult> => {
      order.push("derive");
      return { result: "null" };
    };
    await h.watcher({ deriveEvent }).sweep(NOW);
    expect(order).toEqual(["poll", "derive"]);
  });

  it("drops a derived event whose status no clause on the derived key accepts (final review, item 1)", async () => {
    const h = harness();
    await h.store.createWakeup(eventRow({
      eventBuffer: [digest(1, { status: "success", derive: CHECKS })],
      eventMatch: { clauses: [{ key: CHECKS, status: ["success"] }], once: true, self: [] },
    }));
    await h.watcher({ deriveEvent: async () => ({ result: "event", digest: derived }) }).sweep(NOW);
    const row = await h.store.getWakeup("wk_ev");
    expect(row?.status).toBe("running");
    expect(row?.eventBuffer).toEqual([]);
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it("delivers a derived event whose status a clause on the derived key accepts", async () => {
    const h = harness();
    await h.store.createWakeup(eventRow({
      eventBuffer: [digest(1, { status: "success", derive: CHECKS })],
      eventMatch: { clauses: [{ key: CHECKS, status: ["failure"] }], once: true, self: [] },
    }));
    await h.watcher({ deriveEvent: async () => ({ result: "event", digest: derived }) }).sweep(NOW);
    expect((await h.store.getWakeup("wk_ev"))?.status).toBe("done");
    expect(h.prompt).toHaveBeenCalledTimes(1);
  });

  it("keeps an event waiter's details out of the main thread when its thread is gone, with no process_read advice", async () => {
    const h = harness();
    h.threads.clear();
    await h.store.createWakeup(eventRow({ eventBuffer: [digest(1, { text: "secret reply" })] }));
    await h.watcher().sweep(NOW);
    const { content, opts } = signalOf(h.prompt.mock.calls[0]);
    expect(opts.threadId).toBeUndefined();
    const body = typeof content !== "string" && "body" in content ? content.body : "";
    expect(body).toContain("removed thread matched an event");
    expect(body).not.toContain("process_read");
    expect(body).not.toContain("secret reply");
    // The structured digests carry summaries, so they stay out too.
    expect(attr(content, "digests")).toBeUndefined();
    expect(attr(content, "wakeupId")).toBe("wk_ev");
  });

  it("decides with the watcher clock after a derive, not the pass start", async () => {
    const h = harness();
    let clock = NOW;
    // Stream mode, 100 s after the last emit: inside the 120 s default at
    // the pass start, past it once the derive took 30 s.
    await h.store.createWakeup(eventRow({ eventBuffer: [digest(1, { derive: CHECKS })], eventCount: 1, lastEmitAt: NOW - 100_000 }, false));
    const deriveEvent = async (): Promise<RunDeriveResult> => {
      clock = NOW + 30_000;
      return { result: "event", digest: derived };
    };
    await h.watcher({ deriveEvent, now: () => clock }).sweep(NOW);
    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(signalOf(h.prompt.mock.calls[0]).opts.dispatchId).toBe("wakeup:wk_ev:event:2");
  });

  it("rolls back the emit when removeEventMatches fails after the CAS: no double count, no duplicate signal", async () => {
    const h = harness();
    await h.store.createWakeup(eventRow({ eventBuffer: [digest(1)] }, false));
    const remove = h.store.removeEventMatches.bind(h.store);
    const spy = vi.spyOn(h.store, "removeEventMatches").mockRejectedValueOnce(new Error("connection reset"));
    await h.watcher().sweep(NOW);
    expect(h.prompt).not.toHaveBeenCalled();
    const after = await h.store.getWakeup("wk_ev");
    expect(after).toMatchObject({ status: "running", eventCount: 0, windowCount: 0 });
    expect(after?.eventBuffer?.map((d) => d.dedupeKey)).toEqual(["d-1"]);
    spy.mockImplementation(remove);
    await h.watcher().sweep(NOW + 1);
    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(signalOf(h.prompt.mock.calls[0]).opts.dispatchId).toBe("wakeup:wk_ev:event:1");
    expect(await h.store.getWakeup("wk_ev")).toMatchObject({ eventCount: 1, windowCount: 1, eventBuffer: [] });
    await h.watcher().sweep(NOW + 2);
    expect(h.prompt).toHaveBeenCalledTimes(1);
  });

  it("ignores nudge() before start()", async () => {
    const h = harness();
    const spy = vi.spyOn(h.store, "getWakeup");
    h.watcher({ sweepIntervalMs: HOUR }).nudge(["wk_ev"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spy).not.toHaveBeenCalled();
  });
});

