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

/** `live` is the attachment's raw ready handle; null models a cold session. */
function fakeSession(sandbox: Sandbox, sandboxId = "sb-1", live: Sandbox | null = sandbox): WakeupsSeamSession {
  return { sandbox, attachment: { sandboxId, current: () => live } };
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

    expect(pollJob).toHaveBeenCalledWith("exec-3", 0, { maxBytes: 5 });
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

  it("readLog throws naming the id when it does not resolve to an active wakeup", async () => {
    const store = new InMemorySessionStore();
    const sandbox = fakeSandbox();
    const seam = buildWakeupsSeam(
      { engineStore: store, limits: LIMITS, now: () => NOW },
      "session-1",
      () => fakeSession(sandbox),
    );

    await expect(seam.readLog("wk_doesnotexist", 0, 4096)).rejects.toThrow(
      "[process_read] wk_doesnotexist is not an active wakeup. Call wakeup_list to see active ids.",
    );
  });

  it("readLog throws when the id is a timer, which has no log", async () => {
    const store = new InMemorySessionStore();
    const sandbox = fakeSandbox();
    const seam = buildWakeupsSeam(
      { engineStore: store, limits: LIMITS, now: () => NOW },
      "session-1",
      () => fakeSession(sandbox),
    );

    const { wakeup } = await seam.create("thread-1", { kind: "timer", prompt: "ping", fireAt: NOW + 1000 });

    await expect(seam.readLog(wakeup.id, 0, 4096)).rejects.toThrow(
      `[process_read] ${wakeup.id} is a timer and has no log. Only a background process or watch has a log.`,
    );
  });

  it("readLog throws when the sandbox backend cannot read background logs", async () => {
    const store = new InMemorySessionStore();
    const sandbox = fakeSandbox({
      execJob: vi.fn().mockResolvedValue({ execId: "exec-6" } satisfies ExecJobHandle),
      pollJob: undefined,
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

    await expect(seam.readLog(wakeup.id, 0, 4096)).rejects.toThrow(
      "[process_read] this sandbox backend cannot read background logs.",
    );
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
    expect((await seam.list()).wakeups).toHaveLength(0);
  });

  describe("fix wave 1: session scoping (I4)", () => {
    async function foreignRows(store: InMemorySessionStore): Promise<void> {
      await store.createWakeup({
        id: "wk_foreign", sessionId: "session-2", threadId: "t2", kind: "process", status: "running",
        reason: "other", command: "sleep 1", execId: "exec-x", leaseId: "ls_foreign", deadlineAt: NOW + 3_600_000,
        logOffset: 0, logTail: "", eventCount: 0, createdAt: NOW, updatedAt: NOW,
      });
      await store.createLease({
        id: "ls_foreign", sessionId: "session-2", sandboxId: "sb-2", ownerKind: "process", ownerId: "wk_foreign",
        reason: "other", createdAt: NOW, deadlineAt: NOW + 3_600_000,
      });
      await store.createLease({
        id: "ls_foreign_hold", sessionId: "session-2", ownerKind: "hold", reason: "other", createdAt: NOW, deadlineAt: NOW + 3_600_000,
      });
    }

    it("treats another session's wakeup and lease ids as unknown", async () => {
      const store = new InMemorySessionStore();
      await foreignRows(store);
      const cancelJob = vi.fn();
      const pollJob = vi.fn();
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, now: () => NOW }, "session-1", () =>
        fakeSession(fakeSandbox({ cancelJob, pollJob })),
      );

      expect(await seam.get("wk_foreign")).toBeNull();
      expect(await seam.cancel("wk_foreign")).toBeNull();
      expect(await seam.cancel("ls_foreign_hold")).toBeNull();
      await expect(seam.readLog("wk_foreign", 0, 10)).rejects.toThrow("[process_read] wk_foreign is not an active wakeup.");
      expect(cancelJob).not.toHaveBeenCalled();
      expect(pollJob).not.toHaveBeenCalled();
      expect(await store.getWakeup("wk_foreign")).toMatchObject({ status: "running" });
      expect(await store.countActiveLeases("session-2")).toBe(2);
    });

    it("refuses to cancel a process-owned lease and names the wakeup id", async () => {
      const store = new InMemorySessionStore();
      const sandbox = fakeSandbox({ execJob: vi.fn().mockResolvedValue({ execId: "exec-p" } satisfies ExecJobHandle) });
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, now: () => NOW }, "session-1", () => fakeSession(sandbox));
      const { wakeup, lease } = await seam.create("thread-1", { kind: "process", command: "make", reason: "build", deadlineHours: 2 });
      if (!lease) throw new Error("expected a lease");

      const result = await seam.cancel(lease.id);

      expect(result).toEqual({
        kind: "refused",
        text: `[wakeup_cancel] ${lease.id} belongs to process ${wakeup.id}. Cancel ${wakeup.id} instead; that stops the process and releases this lease.`,
      });
      expect(await store.countActiveLeases("session-1")).toBe(1);
    });
  });

  describe("fix wave 1: best-effort kill on cancel (I6)", () => {
    it("kills through the raw ready handle, not the policy sandbox", async () => {
      const store = new InMemorySessionStore();
      const policyCancel = vi.fn();
      const rawCancel = vi.fn().mockResolvedValue(undefined);
      const policy = fakeSandbox({ execJob: vi.fn().mockResolvedValue({ execId: "exec-k" } satisfies ExecJobHandle), cancelJob: policyCancel });
      const raw = fakeSandbox({ cancelJob: rawCancel });
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, now: () => NOW }, "session-1", () => fakeSession(policy, "sb-1", raw));
      const { wakeup } = await seam.create("thread-1", { kind: "process", command: "sleep 9", reason: "r", deadlineHours: 1 });

      expect(await seam.cancel(wakeup.id)).toEqual({ kind: "wakeup" });
      expect(rawCancel).toHaveBeenCalledWith("exec-k");
      expect(policyCancel).not.toHaveBeenCalled();
    });

    it("still cancels the row and releases the lease when the kill throws", async () => {
      const store = new InMemorySessionStore();
      const sandbox = fakeSandbox({
        execJob: vi.fn().mockResolvedValue({ execId: "exec-t" } satisfies ExecJobHandle),
        cancelJob: vi.fn().mockRejectedValue(new Error("sandbox unavailable")),
      });
      const recordEnded = vi.fn();
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, recordEnded, now: () => NOW }, "session-1", () => fakeSession(sandbox));
      const { wakeup } = await seam.create("thread-1", { kind: "process", command: "sleep 9", reason: "r", deadlineHours: 1 });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(await seam.cancel(wakeup.id)).toEqual({ kind: "wakeup" });
      warn.mockRestore();
      expect(await store.getWakeup(wakeup.id)).toMatchObject({ status: "cancelled", cause: "cancelled" });
      expect(await store.countActiveLeases("session-1")).toBe(0);
      expect(recordEnded).toHaveBeenCalledWith("process", "cancelled");
    });

    it("restores the lease's sandbox to kill when the session holds no ready handle", async () => {
      const store = new InMemorySessionStore();
      const policy = fakeSandbox({ execJob: vi.fn().mockResolvedValue({ execId: "exec-c" } satisfies ExecJobHandle) });
      const restoredCancel = vi.fn().mockResolvedValue(undefined);
      const restore = vi.fn(async (_id: string) => fakeSandbox({ cancelJob: restoredCancel }));
      const seam = buildWakeupsSeam(
        { engineStore: store, limits: LIMITS, provider: { restore }, now: () => NOW },
        "session-1",
        () => fakeSession(policy, "sb-1", null),
      );
      const { wakeup } = await seam.create("thread-1", { kind: "watch", command: "follow the log", reason: "r", maxHours: 1 });

      await seam.cancel(wakeup.id);

      expect(restore).toHaveBeenCalledWith("sb-1");
      expect(restoredCancel).toHaveBeenCalledWith("exec-c");
    });
  });

  describe("fix wave 1: lease deadline bound (INV-1)", () => {
    it("refuses a 100h hold under a 72h max", async () => {
      const store = new InMemorySessionStore();
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, now: () => NOW }, "session-1", () => fakeSession(fakeSandbox()));
      await expect(seam.hold({ hours: 100, reason: "too long" })).rejects.toThrow(
        "[lease_limit] A lease of 100h exceeds sandbox.leaseMaxHours (72h). Request between 1 and 72 hours.",
      );
      expect(await store.countActiveLeases("session-1")).toBe(0);
    });

    it("refuses a 100h process before it starts anything", async () => {
      const store = new InMemorySessionStore();
      const execJob = vi.fn();
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, now: () => NOW }, "session-1", () => fakeSession(fakeSandbox({ execJob })));
      await expect(seam.create("thread-1", { kind: "process", command: "x", reason: "r", deadlineHours: 100 })).rejects.toThrow("[lease_limit]");
      expect(execJob).not.toHaveBeenCalled();
      expect(await store.listWakeups("session-1")).toEqual([]);
    });
  });
});
