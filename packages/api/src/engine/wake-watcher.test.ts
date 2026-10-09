import { describe, expect, it, vi } from "vitest";
import {
  InMemorySessionStore,
  SandboxEvictedError,
  SandboxGoneError,
  SandboxSupersededError,
  SandboxUnavailableError,
} from "@valet/engine";
import type {
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
  watcher(extra?: Partial<Pick<WakeWatcherDeps, "batchSize" | "metrics" | "jobLogDir" | "sweepIntervalMs">>): WakeWatcher;
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
    const { opts } = signalOf(h.prompt.mock.calls[0]);
    expect(opts).toEqual({ dispatchId: "wakeup:wk_a:terminal", queueMode: "followup" });
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
      expect(String(signalOf(h.prompt.mock.calls[0]).content.body)).toContain("The log hit its size cap");
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
