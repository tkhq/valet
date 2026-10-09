import { describe, expect, it, vi } from "vitest";
import { InMemorySessionStore, recordWakeupEnded, SandboxUnavailableError } from "@valet/engine";
import type { ExecResult, JobPoll, Lease, PromptContent, PromptOptions, Sandbox, Wakeup } from "@valet/engine";
vi.mock("@valet/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@valet/engine")>();
  return { ...actual, recordWakeupEnded: vi.fn() };
});

import { WakeWatcher, type WakeWatcherDeps, type WakeWatcherSession } from "./wake-watcher.js";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const LIMITS = { leaseMaxHours: 72, timerMaxHours: 720, perSession: 20, watchMaxEventsPerHour: 120 };

type PollScript = (execId: string, offset: number) => Promise<JobPoll>;

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
  watcher(): WakeWatcher;
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
  const deps: WakeWatcherDeps = {
    engineStore: store,
    engineHost: { sessionFor, liveSession: () => null },
    loadSession: async (sessionId) => sessionFor(sessionId),
    provider: { restore, setEvictionProtection, listEvictionProtected },
    limits: LIMITS,
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
    watcher: () => new WakeWatcher(deps),
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
    const releaseSpy = vi.spyOn(h.store, "releaseLease");
    await h.watcher().sweep();
    expect(releaseSpy).toHaveBeenCalledWith("ls_a", "owner_ended", NOW);
    expect(await h.store.countActiveLeases("sess-1")).toBe(0);
  });

  it("lets only one of two concurrent watchers win the CAS", async () => {
    const h = harness(async () => ({ status: "done", exitCode: 0, output: "", nextOffset: 0 }));
    await seedProcess(h.store);
    const releaseSpy = vi.spyOn(h.store, "releaseLease");

    await Promise.all([h.watcher().sweep(), h.watcher().sweep()]);

    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
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
    const releaseSpy = vi.spyOn(h.store, "releaseLease");

    await h.watcher().sweep();

    expect(h.cancelJob).toHaveBeenCalledWith("exec-1");
    expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "expired", cause: "deadline" });
    expect(await h.store.listActiveLeases("sess-1")).toEqual([]);
    expect(releaseSpy).toHaveBeenCalledWith("ls_a", "deadline", NOW);
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

    expect(await h.store.getWakeup("wk_a")).toMatchObject({ status: "running", logOffset: 6, eventCount: 3 });
    expect(await h.store.countActiveLeases("sess-1")).toBe(1);
    const { content, opts } = signalOf(h.prompt.mock.calls[0]);
    expect(content).toMatchObject({ kind: "signal", signalType: "watch.event", body: "a\nb\nc" });
    expect(attr(content, "lineCount")).toBe("3");
    expect(opts.dispatchId).toBe("wakeup:wk_a:event:3");
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

  it("logs a corrupted timer row and continues the tick", async () => {
    const h = harness();
    await h.store.createWakeup(
      wakeup({ id: "wk_bad", kind: "timer", status: "pending", prompt: undefined, fireAt: NOW - 1, execId: undefined, leaseId: undefined }),
    );
    await h.store.createWakeup(
      wakeup({ id: "wk_ok", kind: "timer", status: "pending", prompt: "ok", fireAt: NOW - 1, execId: undefined, leaseId: undefined }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await h.watcher().sweep();

    expect(await h.store.getWakeup("wk_ok")).toMatchObject({ status: "done" });
    expect(await h.store.getWakeup("wk_bad")).toMatchObject({ status: "pending" });
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

  it("delivers and records the end when the lease release throws after the CAS", async () => {
    const h = harness(async () => ({ status: "done", exitCode: 0, output: "", nextOffset: 0 }));
    await seedProcess(h.store);
    vi.spyOn(h.store, "releaseLease").mockRejectedValueOnce(new Error("db blip"));
    vi.mocked(recordWakeupEnded).mockClear();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(h.watcher().sweep()).resolves.toBeUndefined();

    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(recordWakeupEnded).toHaveBeenCalledWith("process", "exit");
    expect(error.mock.calls.some((c) => String(c[0]).includes("lease ls_a release failed after wakeup wk_a moved to done"))).toBe(true);
    expect(error.mock.calls.some((c) => String(c[0]).includes("stays due"))).toBe(false);
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
});
