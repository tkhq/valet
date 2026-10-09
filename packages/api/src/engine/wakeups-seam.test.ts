import { describe, expect, it, vi } from "vitest";
import { InMemorySessionStore } from "@valet/engine";
import type { ExecJobHandle, JobPoll, Sandbox } from "@valet/engine";
import { buildWakeupsSeam, type WakeupsSeamSession } from "./wakeups-seam.js";

const LIMITS = { leaseMaxHours: 72, timerMaxHours: 720, perSession: 20, watchMaxEventsPerHour: 120 };

function fakeSandbox(overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    id: "sb-1",
    readFile: vi.fn(),
    readBinary: vi.fn(),
    writeFile: vi.fn(),
    writeBinary: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
    mkdir: vi.fn(),
    rm: vi.fn(),
    exec: vi.fn(),
    execJob: vi.fn(),
    pollJob: vi.fn(),
    cancelJob: vi.fn(),
    ...overrides,
  } as Sandbox;
}

function fakeSession(sandbox: Sandbox, sandboxId = "sb-1"): WakeupsSeamSession {
  return { sandbox, attachment: { sandboxId } };
}

describe("buildWakeupsSeam", () => {
  const NOW = 1_700_000_000_000;

  it("creates a running process wakeup and an active lease with matching ids and a 48h deadline", async () => {
    const store = new InMemorySessionStore();
    const sandbox = fakeSandbox({
      execJob: vi.fn().mockResolvedValue({ execId: "exec-1" } satisfies ExecJobHandle),
    });
    const seam = buildWakeupsSeam(
      { engineStore: store, limits: LIMITS, now: () => NOW },
      "session-1",
      () => fakeSession(sandbox),
    );

    const { wakeup, lease } = await seam.create("thread-1", {
      kind: "process",
      command: "sleep 100",
      reason: "long build",
      deadlineHours: 48,
    });

    expect(sandbox.execJob).toHaveBeenCalledWith("sleep 100", { detached: true });
    expect(wakeup.status).toBe("running");
    expect(wakeup.execId).toBe("exec-1");
    expect(wakeup.leaseId).toBe(lease?.id);
    expect(wakeup.deadlineAt).toBe(NOW + 48 * 3_600_000);

    const active = await store.listActiveLeases("session-1");
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(lease?.id);
    expect(active[0]!.ownerId).toBe(wakeup.id);
    expect(active[0]!.deadlineAt).toBe(NOW + 48 * 3_600_000);
    expect(active[0]!.sandboxId).toBe("sb-1");
  });

  it("creates a timer wakeup with no lease", async () => {
    const store = new InMemorySessionStore();
    const sandbox = fakeSandbox();
    const seam = buildWakeupsSeam(
      { engineStore: store, limits: LIMITS, now: () => NOW },
      "session-1",
      () => fakeSession(sandbox),
    );

    const { wakeup, lease } = await seam.create("thread-1", {
      kind: "timer",
      prompt: "check the deploy",
      fireAt: NOW + 60_000,
    });

    expect(wakeup.status).toBe("pending");
    expect(wakeup.kind).toBe("timer");
    expect(wakeup.fireAt).toBe(NOW + 60_000);
    expect(lease).toBeUndefined();
    expect(await store.listActiveLeases("session-1")).toHaveLength(0);
  });

  it("throws the bash_background text when the sandbox cannot run background processes", async () => {
    const store = new InMemorySessionStore();
    const sandbox = fakeSandbox({ execJob: undefined });
    const seam = buildWakeupsSeam(
      { engineStore: store, limits: LIMITS, now: () => NOW },
      "session-1",
      () => fakeSession(sandbox),
    );

    await expect(
      seam.create("thread-1", { kind: "process", command: "echo hi", reason: "r", deadlineHours: 1 }),
    ).rejects.toThrow("[bash_background] this sandbox backend cannot run background processes.");
  });

  it("cancel on a process calls cancelJob, marks the wakeup cancelled, and releases its lease", async () => {
    const store = new InMemorySessionStore();
    const cancelJob = vi.fn().mockResolvedValue(undefined);
    const sandbox = fakeSandbox({
      execJob: vi.fn().mockResolvedValue({ execId: "exec-2" } satisfies ExecJobHandle),
      cancelJob,
    });
    const seam = buildWakeupsSeam(
      { engineStore: store, limits: LIMITS, now: () => NOW },
      "session-1",
      () => fakeSession(sandbox),
    );

    const { wakeup } = await seam.create("thread-1", {
      kind: "process",
      command: "sleep 100",
      reason: "r",
      deadlineHours: 1,
    });

    const result = await seam.cancel(wakeup.id);

    expect(result).toEqual({ kind: "wakeup" });
    expect(cancelJob).toHaveBeenCalledWith("exec-2");
    const cancelled = await store.getWakeup(wakeup.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.cause).toBe("cancelled");
    const leases = await store.listActiveLeases("session-1");
    expect(leases).toHaveLength(0);
  });

  it("cancel on a lease id releases it directly", async () => {
    const store = new InMemorySessionStore();
    const sandbox = fakeSandbox();
    const seam = buildWakeupsSeam(
      { engineStore: store, limits: LIMITS, now: () => NOW },
      "session-1",
      () => fakeSession(sandbox),
    );

    const lease = await seam.hold({ hours: 2, reason: "terminal in use" });
    const result = await seam.cancel(lease.id);

    expect(result).toEqual({ kind: "lease" });
    expect(await store.listActiveLeases("session-1")).toHaveLength(0);
  });

  it("cancel returns null for an id that is neither an active wakeup nor an active lease", async () => {
    const store = new InMemorySessionStore();
    const sandbox = fakeSandbox();
    const seam = buildWakeupsSeam(
      { engineStore: store, limits: LIMITS, now: () => NOW },
      "session-1",
      () => fakeSession(sandbox),
    );

    expect(await seam.cancel("wk_doesnotexist")).toBeNull();
    expect(await seam.cancel("ls_doesnotexist")).toBeNull();
  });

  it("readLog slices output, advances the offset, and reports eof once the job finishes", async () => {
    const store = new InMemorySessionStore();
    const pollJob = vi.fn().mockResolvedValue({
      status: "done",
      exitCode: 0,
      output: "hello world",
      nextOffset: 11,
    } satisfies JobPoll);
    const sandbox = fakeSandbox({
      execJob: vi.fn().mockResolvedValue({ execId: "exec-3" } satisfies ExecJobHandle),
      pollJob,
    });
    const seam = buildWakeupsSeam(
      { engineStore: store, limits: LIMITS, now: () => NOW },
      "session-1",
      () => fakeSession(sandbox),
    );

    const { wakeup } = await seam.create("thread-1", {
      kind: "process",
      command: "echo hello world",
      reason: "r",
      deadlineHours: 1,
    });

    const result = await seam.readLog(wakeup.id, 0, 5);

    expect(pollJob).toHaveBeenCalledWith("exec-3", 0);
    expect(result.text).toBe("hello");
    expect(result.nextOffset).toBe(5);
    expect(result.eof).toBe(false);
  });

  it("readLog reports eof when the job is done and the full output was read", async () => {
    const store = new InMemorySessionStore();
    const pollJob = vi.fn().mockResolvedValue({
      status: "done",
      exitCode: 0,
      output: "hi",
      nextOffset: 2,
    } satisfies JobPoll);
    const sandbox = fakeSandbox({
      execJob: vi.fn().mockResolvedValue({ execId: "exec-4" } satisfies ExecJobHandle),
      pollJob,
    });
    const seam = buildWakeupsSeam(
      { engineStore: store, limits: LIMITS, now: () => NOW },
      "session-1",
      () => fakeSession(sandbox),
    );

    const { wakeup } = await seam.create("thread-1", {
      kind: "process",
      command: "echo hi",
      reason: "r",
      deadlineHours: 1,
    });

    const result = await seam.readLog(wakeup.id, 0, 4096);

    expect(result.text).toBe("hi");
    expect(result.eof).toBe(true);
  });

  it("list returns pending/running wakeups and active leases for the session", async () => {
    const store = new InMemorySessionStore();
    const sandbox = fakeSandbox({
      execJob: vi.fn().mockResolvedValue({ execId: "exec-5" } satisfies ExecJobHandle),
    });
    const seam = buildWakeupsSeam(
      { engineStore: store, limits: LIMITS, now: () => NOW },
      "session-1",
      () => fakeSession(sandbox),
    );

    await seam.create("thread-1", { kind: "timer", prompt: "ping", fireAt: NOW + 1000 });
    await seam.hold({ hours: 1, reason: "terminal" });

    const { wakeups, leases } = await seam.list();
    expect(wakeups).toHaveLength(1);
    expect(leases).toHaveLength(1);
  });

  it("hold creates a lease with ownerKind hold and no wakeup", async () => {
    const store = new InMemorySessionStore();
    const sandbox = fakeSandbox();
    const seam = buildWakeupsSeam(
      { engineStore: store, limits: LIMITS, now: () => NOW },
      "session-1",
      () => fakeSession(sandbox),
    );

    const lease = await seam.hold({ hours: 3, reason: "terminal in use" });

    expect(lease.ownerKind).toBe("hold");
    expect(lease.deadlineAt).toBe(NOW + 3 * 3_600_000);
    expect(lease.sandboxId).toBe("sb-1");
  });
});
