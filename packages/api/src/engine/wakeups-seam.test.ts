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

/** A store that holds `session-1`, as every real session's store does. */
async function storeWithSession(): Promise<InMemorySessionStore> {
  const store = new InMemorySessionStore();
  await store.saveSession({
    id: "session-1", userId: "u1", orgId: "o1", owner: { type: "user", id: "u1" }, workspace: "/",
    purpose: "interactive", status: "running", createdAt: 1, updatedAt: 1,
  });
  return store;
}

/** `live` is the attachment's raw ready handle; null models a cold session. */
function fakeSession(sandbox: Sandbox, sandboxId = "sb-1", live: Sandbox | null = sandbox): WakeupsSeamSession {
  return { sandbox, attachment: { sandboxId, current: () => live } };
}

describe("buildWakeupsSeam", () => {
  const NOW = 1_700_000_000_000;

  it("creates a running process wakeup and an active lease with matching ids and a 48h deadline", async () => {
    const store = await storeWithSession();
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

    expect(sandbox.execJob).toHaveBeenCalledWith("sleep 100", expect.objectContaining({ detached: true }));
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
    const store = await storeWithSession();
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
    const store = await storeWithSession();
    const sandbox = fakeSandbox({ execJob: undefined });
    const seam = buildWakeupsSeam(
      { engineStore: store, limits: LIMITS, now: () => NOW },
      "session-1",
      () => fakeSession(sandbox),
    );

    await expect(
      seam.create("thread-1", { kind: "process", command: "echo hi", reason: "r", deadlineHours: 1 }),
    ).rejects.toThrow("[bash_background] This sandbox backend cannot run background processes. Run the command in the foreground with a timeout of up to 3600 seconds.");
  });

  it("cancel on a process calls cancelJob, marks the wakeup cancelled, and releases its lease", async () => {
    const store = await storeWithSession();
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
    const store = await storeWithSession();
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
    const store = await storeWithSession();
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
    const store = await storeWithSession();
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
    const store = await storeWithSession();
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
    const store = await storeWithSession();
    const sandbox = fakeSandbox();
    const seam = buildWakeupsSeam(
      { engineStore: store, limits: LIMITS, now: () => NOW },
      "session-1",
      () => fakeSession(sandbox),
    );

    await expect(seam.readLog("wk_doesnotexist", 0, 4096)).rejects.toThrow(
      "[process_read] wk_doesnotexist is not a background process or watch of this session. Call wakeup_list to see this thread's ids.",
    );
  });

  it("readLog throws when the id is a timer, which has no log", async () => {
    const store = await storeWithSession();
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
    const store = await storeWithSession();
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
    const store = await storeWithSession();
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

    const { wakeups, leases } = await seam.list("thread-1");
    expect(wakeups).toHaveLength(1);
    expect(leases).toHaveLength(1);
  });

  it("hold creates a lease with ownerKind hold and no wakeup", async () => {
    const store = await storeWithSession();
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
    expect((await seam.list("thread-1")).wakeups).toHaveLength(0);
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
      const store = await storeWithSession();
      await foreignRows(store);
      const cancelJob = vi.fn();
      const pollJob = vi.fn();
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, now: () => NOW }, "session-1", () =>
        fakeSession(fakeSandbox({ cancelJob, pollJob })),
      );

      expect(await seam.get("wk_foreign")).toBeNull();
      expect(await seam.cancel("wk_foreign")).toBeNull();
      expect(await seam.cancel("ls_foreign_hold")).toBeNull();
      await expect(seam.readLog("wk_foreign", 0, 10)).rejects.toThrow("[process_read] wk_foreign is not a background process or watch of this session.");
      expect(cancelJob).not.toHaveBeenCalled();
      expect(pollJob).not.toHaveBeenCalled();
      expect(await store.getWakeup("wk_foreign")).toMatchObject({ status: "running" });
      expect(await store.countActiveLeases("session-2")).toBe(2);
    });

    it("refuses to cancel a process-owned lease and names the wakeup id", async () => {
      const store = await storeWithSession();
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
      const store = await storeWithSession();
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
      const store = await storeWithSession();
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
      const store = await storeWithSession();
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

  describe("fix wave 2: durable create and cancel (B2, H10, M1)", () => {
    it("writes the pending row and its lease before the job starts, with a pre-generated exec id and the log cap", async () => {
      const store = await storeWithSession();
      const seen: Array<{ status?: string; leases: number }> = [];
      const execJob = vi.fn(async (_cmd: string, opts?: { execId?: string }) => {
        const rows = await store.listWakeups("session-1");
        seen.push({ status: rows[0]?.status, leases: await store.countActiveLeases("session-1") });
        return { execId: opts?.execId ?? "missing" } satisfies ExecJobHandle;
      });
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, jobLogMaxBytes: 1234, now: () => NOW }, "session-1", () =>
        fakeSession(fakeSandbox({ execJob })),
      );

      const { wakeup } = await seam.create("thread-1", { kind: "process", command: "make", reason: "build", deadlineHours: 2 });

      expect(seen).toEqual([{ status: "pending", leases: 1 }]);
      const opts = execJob.mock.calls[0]?.[1];
      expect(opts).toMatchObject({ detached: true, maxOutputBytes: 1234 });
      expect(opts?.execId).toMatch(/^job-[0-9a-z]+-[0-9a-z]{8}$/);
      expect(wakeup).toMatchObject({ status: "running", execId: opts?.execId });
      expect(await store.getWakeup(wakeup.id)).toMatchObject({ status: "running", execId: opts?.execId });
    });

    it("defaults the detached log cap to 2 GiB", async () => {
      const store = await storeWithSession();
      const execJob = vi.fn().mockResolvedValue({ execId: "job-a-12345678" } satisfies ExecJobHandle);
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, now: () => NOW }, "session-1", () => fakeSession(fakeSandbox({ execJob })));
      await seam.create("thread-1", { kind: "watch", command: "tail -f x", reason: "r", maxHours: 1 });
      expect(execJob.mock.calls[0]?.[1]).toMatchObject({ maxOutputBytes: 2 * 1024 ** 3 });
    });

    it("ends the row and releases the lease when the start fails, and kills the requested id", async () => {
      const store = await storeWithSession();
      const rawCancel = vi.fn().mockResolvedValue(undefined);
      const policy = fakeSandbox({ execJob: vi.fn().mockRejectedValue(new Error("kickoff failed")) });
      const raw = fakeSandbox({ cancelJob: rawCancel });
      const recordEnded = vi.fn();
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, recordEnded, now: () => NOW }, "session-1", () =>
        fakeSession(policy, "sb-1", raw),
      );

      await expect(seam.create("thread-1", { kind: "process", command: "make", reason: "r", deadlineHours: 1 })).rejects.toThrow("kickoff failed");

      const [row] = await store.listWakeups("session-1");
      expect(row).toMatchObject({ status: "lost", cause: "pid_missing" });
      expect(await store.countActiveLeases("session-1")).toBe(0);
      expect(rawCancel).toHaveBeenCalledWith(row?.execId);
      expect(recordEnded).toHaveBeenCalledWith("process", "pid_missing");
    });

    it("kills the started job and refuses when the watcher ended the pending row during the start", async () => {
      const store = await storeWithSession();
      const rawCancel = vi.fn().mockResolvedValue(undefined);
      const execJob = vi.fn(async (_cmd: string, opts?: { execId?: string }) => {
        const [row] = await store.listWakeups("session-1");
        if (row) await store.transitionWakeupAndReleaseLease(row.id, ["pending"], "lost", { cause: "pid_missing" }, NOW, "owner_ended");
        return { execId: opts?.execId ?? "x" } satisfies ExecJobHandle;
      });
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, now: () => NOW }, "session-1", () =>
        fakeSession(fakeSandbox({ execJob }), "sb-1", fakeSandbox({ cancelJob: rawCancel })),
      );

      await expect(seam.create("thread-1", { kind: "process", command: "make", reason: "r", deadlineHours: 1 })).rejects.toThrow(
        /^\[bash_background\] The start of wk_\w+ took too long, so it was stopped\. Run the command again\.$/,
      );
      expect(rawCancel).toHaveBeenCalledWith(execJob.mock.calls[0]?.[1]?.execId);
    });

    it("cancel moves the row first and kills after; a lost CAS kills nothing", async () => {
      const store = await storeWithSession();
      const order: string[] = [];
      let liveId = "";
      const rawCancel = vi.fn(async () => {
        order.push(`kill:${(await store.getWakeup(liveId))?.status}`);
      });
      const sandbox = fakeSandbox({ execJob: vi.fn().mockResolvedValue({ execId: "job-a-12345678" } satisfies ExecJobHandle), cancelJob: rawCancel });
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, now: () => NOW }, "session-1", () => fakeSession(sandbox));
      const done = await seam.create("thread-1", { kind: "process", command: "a", reason: "r", deadlineHours: 1 });
      const live = await seam.create("thread-1", { kind: "process", command: "b", reason: "r", deadlineHours: 1 });
      liveId = live.wakeup.id;
      await store.transitionWakeupAndReleaseLease(done.wakeup.id, ["running"], "done", { cause: "exit", exitCode: 0 }, NOW, "owner_ended");

      expect(await seam.cancel(done.wakeup.id)).toBeNull();
      expect(rawCancel).not.toHaveBeenCalled();

      expect(await seam.cancel(live.wakeup.id)).toEqual({ kind: "wakeup" });
      expect(order).toEqual(["kill:cancelled"]);
      expect(await store.getWakeup(live.wakeup.id)).toMatchObject({ status: "cancelled" });
      expect(await store.countActiveLeases("session-1")).toBe(0);
    });
  });

  describe("fix wave 2: origin, thread, and holds (H3, M10, M14, M17)", () => {
    const origin = { channelType: "slack", threadKey: "slack:C1:1.2", messageTs: "1.2" };

    it("stores the calling turn's origin on the wakeup and its lease, and the thread on the lease", async () => {
      const store = await storeWithSession();
      const sandbox = fakeSandbox({ execJob: vi.fn().mockResolvedValue({ execId: "job-a-12345678" } satisfies ExecJobHandle) });
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, now: () => NOW }, "session-1", () => fakeSession(sandbox));
      const { wakeup, lease } = await seam.create("thread-1", { kind: "process", command: "a", reason: "r", deadlineHours: 1, origin });
      const timer = await seam.create("thread-1", { kind: "timer", prompt: "p", fireAt: NOW + 60_000, origin });
      const hold = await seam.hold({ hours: 1, reason: "terminal", threadId: "thread-2", origin });

      expect((await store.getWakeup(wakeup.id))?.origin).toEqual(origin);
      expect((await store.getWakeup(timer.wakeup.id))?.origin).toEqual(origin);
      const leases = await store.listActiveLeases("session-1");
      expect(leases.find((l) => l.id === lease?.id)).toMatchObject({ threadId: "thread-1", origin });
      expect(leases.find((l) => l.id === hold.id)).toMatchObject({ threadId: "thread-2", origin });
    });

    it("refuses a hold when the session has no sandbox", async () => {
      const store = await storeWithSession();
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, now: () => NOW }, "session-1", () => ({
        sandbox: fakeSandbox(),
        attachment: { sandboxId: undefined, current: () => null },
      }));
      await expect(seam.hold({ hours: 1, reason: "r" })).rejects.toThrow(
        "[hold_sandbox] No sandbox is running. Start work that needs the sandbox first.",
      );
      expect(await store.countActiveLeases("session-1")).toBe(0);
    });

    it("lists the calling thread's rows and counts the other threads' rows", async () => {
      const store = await storeWithSession();
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, now: () => NOW }, "session-1", () => fakeSession(fakeSandbox()));
      await seam.create("thread-1", { kind: "timer", prompt: "mine", fireAt: NOW + 60_000 });
      await seam.create("thread-2", { kind: "timer", prompt: "theirs", fireAt: NOW + 60_000 });
      await seam.hold({ hours: 1, reason: "mine", threadId: "thread-1" });
      await seam.hold({ hours: 1, reason: "theirs", threadId: "thread-2" });

      const listing = await seam.list("thread-1");
      expect(listing.wakeups.map((w) => w.prompt)).toEqual(["mine"]);
      expect(listing.leases.map((l) => l.reason)).toEqual(["mine"]);
      expect(listing.otherThreads).toBe(2);
    });
  });

  describe("fix wave 2: process_read (H5, M15)", () => {
    async function seededRow(store: InMemorySessionStore, status: "running" | "done" = "running"): Promise<void> {
      await store.createWakeupWithLease(
        {
          id: "wk_r", sessionId: "session-1", threadId: "thread-1", kind: "process", status, reason: "r", command: "c",
          execId: "job-r-12345678", leaseId: "ls_r", deadlineAt: NOW + 3_600_000, logOffset: 0, logTail: "", eventCount: 0,
          createdAt: NOW, updatedAt: NOW,
        },
        { id: "ls_r", sessionId: "session-1", sandboxId: "sb-1", ownerKind: "process", ownerId: "wk_r", reason: "r", createdAt: NOW, deadlineAt: NOW + 3_600_000 },
      );
    }

    it("passes tail through to the raw handle and never touches the policy sandbox", async () => {
      const store = await storeWithSession();
      await seededRow(store);
      const policyPoll = vi.fn();
      const rawPoll = vi.fn().mockResolvedValue({ status: "running", output: "end of log", nextOffset: 900 } satisfies JobPoll);
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, now: () => NOW }, "session-1", () =>
        fakeSession(fakeSandbox({ pollJob: policyPoll }), "sb-1", fakeSandbox({ pollJob: rawPoll })),
      );

      const result = await seam.readLog("wk_r", 0, 10, { tail: true });

      expect(rawPoll).toHaveBeenCalledWith("job-r-12345678", 0, { maxBytes: 10, tail: true });
      expect(policyPoll).not.toHaveBeenCalled();
      expect(result).toEqual({ text: "end of log", nextOffset: 900, eof: false });
    });

    it("restores the lease's sandbox when the session holds no ready handle", async () => {
      const store = await storeWithSession();
      await seededRow(store);
      const rawPoll = vi.fn().mockResolvedValue({ status: "running", output: "x", nextOffset: 1 } satisfies JobPoll);
      const restore = vi.fn(async (_id: string) => fakeSandbox({ pollJob: rawPoll }));
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, provider: { restore }, now: () => NOW }, "session-1", () =>
        fakeSession(fakeSandbox(), "sb-1", null),
      );
      await seam.readLog("wk_r", 0, 10);
      expect(restore).toHaveBeenCalledWith("sb-1");
    });

    it("refuses without waking compute when no sandbox runs", async () => {
      const store = await storeWithSession();
      await seededRow(store, "done");
      const policyPoll = vi.fn();
      const restore = vi.fn(async (_id: string): Promise<Sandbox> => {
        throw new Error('Sandbox CR "sb-1" not found');
      });
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, provider: { restore }, now: () => NOW }, "session-1", () =>
        fakeSession(fakeSandbox({ pollJob: policyPoll }), "sb-1", null),
      );
      await expect(seam.readLog("wk_r", 0, 10)).rejects.toThrow("[process_read] The sandbox is not running, so the log is gone with it. The process.exited signal kept the last 4 KB of output, and files in /workspace remain.");
      expect(policyPoll).not.toHaveBeenCalled();
    });
  });

  describe("fix wave 1: lease deadline bound (INV-1)", () => {
    it("refuses a 100h hold under a 72h max", async () => {
      const store = await storeWithSession();
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, now: () => NOW }, "session-1", () => fakeSession(fakeSandbox()));
      await expect(seam.hold({ hours: 100, reason: "too long" })).rejects.toThrow(
        "[lease_limit] A lease of 100h exceeds sandbox.leaseMaxHours (72h). Request between 1 and 72 hours.",
      );
      expect(await store.countActiveLeases("session-1")).toBe(0);
    });

    it("refuses a 100h process before it starts anything", async () => {
      const store = await storeWithSession();
      const execJob = vi.fn();
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, now: () => NOW }, "session-1", () => fakeSession(fakeSandbox({ execJob })));
      await expect(seam.create("thread-1", { kind: "process", command: "x", reason: "r", deadlineHours: 100 })).rejects.toThrow("[lease_limit]");
      expect(execJob).not.toHaveBeenCalled();
      expect(await store.listWakeups("session-1")).toEqual([]);
    });
  });

  describe("fix wave 3", () => {
    it("ends the rows and starts nothing when the session was deleted during the create (data probable 2)", async () => {
      const store = new InMemorySessionStore();
      const execJob = vi.fn();
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, now: () => NOW }, "session-1", () => fakeSession(fakeSandbox({ execJob })));
      await expect(seam.create("thread-1", { kind: "process", command: "x", reason: "r", deadlineHours: 1 })).rejects.toThrow(
        "[bash_background] This session was deleted, so the command did not start.",
      );
      expect(execJob).not.toHaveBeenCalled();
      expect(await store.listWakeups("session-1", ["pending", "running"])).toEqual([]);
      expect(await store.countActiveLeases("session-1")).toBe(0);
      await expect(seam.create("thread-1", { kind: "timer", prompt: "p", fireAt: NOW + 60_000 })).rejects.toThrow("[wake_at]");
      expect(await store.listWakeups("session-1", ["pending", "running"])).toEqual([]);
    });

    it("returns the started process when the running write throws, and leaves the row pending for the watcher (concurrency L6)", async () => {
      const store = await storeWithSession();
      const rawCancel = vi.fn();
      const execJob = vi.fn(async (_cmd: string, opts?: { execId?: string }) => ({ execId: opts?.execId ?? "x" }) satisfies ExecJobHandle);
      vi.spyOn(store, "transitionWakeup").mockRejectedValueOnce(new Error("db blip"));
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, now: () => NOW }, "session-1", () =>
        fakeSession(fakeSandbox({ execJob }), "sb-1", fakeSandbox({ cancelJob: rawCancel })),
      );
      const warn = vi.spyOn(console, "error").mockImplementation(() => {});
      const { wakeup } = await seam.create("thread-1", { kind: "process", command: "make", reason: "r", deadlineHours: 1 });
      warn.mockRestore();
      expect(wakeup.execId).toBe(execJob.mock.calls[0]?.[1]?.execId);
      expect(await store.getWakeup(wakeup.id)).toMatchObject({ status: "pending", execId: wakeup.execId });
      expect(await store.countActiveLeases("session-1")).toBe(1);
      expect(rawCancel).not.toHaveBeenCalled();
    });

    it("tells the agent a person stopped the start when a human cancel won the pending row (concurrency L2)", async () => {
      const store = await storeWithSession();
      const rawCancel = vi.fn().mockResolvedValue(undefined);
      const execJob = vi.fn(async (_cmd: string, opts?: { execId?: string }) => {
        const [row] = await store.listWakeups("session-1");
        if (row) await store.transitionWakeupAndReleaseLease(row.id, ["pending"], "cancelled", { cause: "cancelled" }, NOW, "cancelled");
        return { execId: opts?.execId ?? "x" } satisfies ExecJobHandle;
      });
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, now: () => NOW }, "session-1", () =>
        fakeSession(fakeSandbox({ execJob }), "sb-1", fakeSandbox({ cancelJob: rawCancel })),
      );
      await expect(seam.create("thread-1", { kind: "process", command: "make", reason: "r", deadlineHours: 1 })).rejects.toThrow(
        /^\[bash_background\] wk_\w+ was cancelled before it started, so it was stopped\. Do not start it again unless someone asks\.$/,
      );
      expect(rawCancel).toHaveBeenCalled();
    });

    it("caps a detached log at a quarter of the session's scratch when that is smaller (k8s M-B)", async () => {
      const store = await storeWithSession();
      const execJob = vi.fn().mockResolvedValue({ execId: "job-a-12345678" } satisfies ExecJobHandle);
      const seam = buildWakeupsSeam(
        { engineStore: store, limits: LIMITS, jobLogMaxBytes: 2 * 1024 ** 3, scratchBytes: () => 1024 ** 3, now: () => NOW },
        "session-1",
        () => fakeSession(fakeSandbox({ execJob })),
      );
      await seam.create("thread-1", { kind: "process", command: "make", reason: "r", deadlineHours: 1 });
      expect(execJob.mock.calls[0]?.[1]).toMatchObject({ maxOutputBytes: 256 * 1024 ** 2 });
    });

    it("ignores VALET_JOB_LOG_MAX_BYTES; the host resolves it at boot (data M3)", async () => {
      const store = await storeWithSession();
      const execJob = vi.fn().mockResolvedValue({ execId: "job-a-12345678" } satisfies ExecJobHandle);
      vi.stubEnv("VALET_JOB_LOG_MAX_BYTES", "not-a-size");
      try {
        const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, now: () => NOW }, "session-1", () => fakeSession(fakeSandbox({ execJob })));
        await seam.create("thread-1", { kind: "process", command: "make", reason: "r", deadlineHours: 1 });
      } finally {
        vi.unstubAllEnvs();
      }
      expect(execJob.mock.calls[0]?.[1]).toMatchObject({ maxOutputBytes: 2 * 1024 ** 3 });
    });

    it("names the session, not the thread, when process_read gets an unknown id (UX L6)", async () => {
      const store = await storeWithSession();
      const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, now: () => NOW }, "session-1", () => fakeSession(fakeSandbox()));
      await expect(seam.readLog("wk_nope", 0, 10)).rejects.toThrow(
        "[process_read] wk_nope is not a background process or watch of this session. Call wakeup_list to see this thread's ids.",
      );
    });
  });
});
