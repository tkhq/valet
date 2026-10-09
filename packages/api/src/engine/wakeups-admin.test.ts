/**
 * The human surface over background work (fix wave 4): the refusal text,
 * the work selection, and the human-cancel signal body.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemorySessionStore } from "@valet/engine";
import type { Lease, PromptContent, PromptOptions, Sandbox, Wakeup } from "@valet/engine";
import {
  backgroundWorkRefusal,
  cancelWorkAsHuman,
  selectWork,
  type BlockingWork,
  type HumanCancelSession,
} from "./wakeups-admin.js";
import { buildWakeupsSeam } from "./wakeups-seam.js";

const NOW = 1_800_000_000_000;

function process(id: string, status: Wakeup["status"], threadId = "th-1"): Wakeup {
  return {
    id,
    sessionId: "s-1",
    threadId,
    kind: "process",
    status,
    reason: `build ${id}`,
    command: "make",
    deadlineAt: NOW + 3_600_000,
    logOffset: 0,
    logTail: "",
    eventCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function hold(id: string, threadId?: string): Lease {
  return {
    id,
    sessionId: "s-1",
    ownerKind: "hold",
    ...(threadId !== undefined ? { threadId } : {}),
    reason: `hold ${id}`,
    createdAt: NOW,
    deadlineAt: NOW + 3_600_000,
  };
}

describe("backgroundWorkRefusal", () => {
  const work: BlockingWork = {
    id: "wk_1",
    kind: "process",
    status: "running",
    reason: "proof build",
    threadId: "th-1",
    deadlineAt: NOW,
    createdAt: NOW,
  };

  it("tells a member who may not stop the work to ask the agent or a team admin (archive)", () => {
    const text = backgroundWorkRefusal("archive", [work], 0, false);
    expect(text).toContain("Ask the agent in this thread to cancel it (wakeup_cancel), or ask a team admin.");
    expect(text).not.toContain("session admin");
  });

  it("names the same path for a session-wide action", () => {
    const text = backgroundWorkRefusal("pause", [work], 0, false);
    expect(text).toContain("Ask the agent to cancel it (wakeup_cancel), or ask a team admin, then pause the session.");
  });
});

describe("selectWork", () => {
  it("ships pending for a process that is still starting, and running for a hold", () => {
    const picked = selectWork(
      { wakeups: [process("wk_a", "pending"), process("wk_b", "running")], leases: [hold("ls_h", "th-1")] },
      {},
    );
    expect(picked.map((w) => [w.id, w.status])).toEqual([
      ["wk_a", "pending"],
      ["wk_b", "running"],
      ["ls_h", "running"],
    ]);
  });

  it("leaves a hold with no thread out of a thread filter, and keeps it session-wide", () => {
    const work = { wakeups: [], leases: [hold("ls_none")] };
    expect(selectWork(work, { threadId: "th-1" })).toEqual([]);
    expect(selectWork(work, { leasedOnly: true }).map((w) => w.id)).toEqual(["ls_none"]);
  });
});

const LIMITS = { leaseMaxHours: 72, timerMaxHours: 720, perSession: 20, watchMaxEventsPerHour: 120 };

function sandbox(): Sandbox {
  const unused = async (): Promise<never> => {
    throw new Error("not used");
  };
  return {
    id: "sb-1",
    readFile: unused,
    readBinary: unused,
    writeFile: unused,
    writeBinary: unused,
    readdir: unused,
    stat: unused,
    mkdir: unused,
    rm: unused,
    exec: unused,
    cancelJob: vi.fn(async () => {}),
  };
}

function watchRow(): Wakeup {
  return {
    id: "wk_w", sessionId: "s1", threadId: "t1", kind: "watch", status: "running", reason: "follow", command: "tail -f x",
    execId: "job-w-12345678", logOffset: 30, logTail: "sent line\n", eventCount: 1, createdAt: NOW - 60_000,
    updatedAt: NOW, lastEmitAt: NOW - 30_000, watchBuffer: "held 1\nheld 2\n",
  };
}

async function cancelBody(deliverTo: "work-thread" | "main"): Promise<string> {
  const store = new InMemorySessionStore();
  await store.createWakeup(watchRow());
  const sb = sandbox();
  const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, now: () => NOW }, "s1", () => ({
    sandbox: sb,
    attachment: { sandboxId: "sb-1", current: () => sb },
  }));
  const prompt = vi.fn(async (_content: PromptContent, _opts: PromptOptions): Promise<unknown> => ({}));
  const session: HumanCancelSession = { options: { wakeups: seam }, prompt, threadById: () => ({}) };
  const result = await cancelWorkAsHuman(store, session, "s1", "wk_w", {
    actorUserId: "u1", signal: "deliver", now: () => NOW, deliverTo,
  });
  expect(result.kind).toBe("cancelled");
  const content = prompt.mock.calls[0]?.[0];
  return typeof content === "object" && content !== null && "body" in content ? String(content.body) : "";
}

describe("cancelWorkAsHuman body (fix wave 4, data N2 and security N3)", () => {
  it("adds a watch's unsent lines after the last output on the work's own thread", async () => {
    const body = await cancelBody("work-thread");
    expect(body).toContain("Last output:\nsent line\n");
    expect(body).toContain("Lines the watch read but did not send yet:\nheld 1\nheld 2\n");
    expect(body.indexOf("Last output")).toBeLessThan(body.indexOf("held 1"));
  });

  it("keeps the last output and the unsent lines off a signal that lands on the main thread", async () => {
    const body = await cancelBody("main");
    expect(body).toContain("A person stopped this watch");
    expect(body).not.toContain("Last output");
    expect(body).not.toContain("held 1");
  });
});
