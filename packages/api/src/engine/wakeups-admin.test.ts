import { describe, expect, it, vi } from "vitest";
import { InMemorySessionStore } from "@valet/engine";
import type { PromptContent, PromptOptions, Sandbox, Wakeup } from "@valet/engine";
import { cancelWorkAsHuman, type HumanCancelSession } from "./wakeups-admin.js";
import { buildWakeupsSeam } from "./wakeups-seam.js";

const LIMITS = { leaseMaxHours: 72, timerMaxHours: 720, perSession: 20, watchMaxEventsPerHour: 120 };
const NOW = 1_700_000_000_000;

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

describe("cancelWorkAsHuman body (fix wave 4, data N2)", () => {
  it("adds a watch's unsent lines after the last output", async () => {
    const store = new InMemorySessionStore();
    const row: Wakeup = {
      id: "wk_w", sessionId: "s1", threadId: "t1", kind: "watch", status: "running", reason: "follow", command: "tail -f x",
      execId: "job-w-12345678", logOffset: 30, logTail: "sent line\n", eventCount: 1, createdAt: NOW - 60_000,
      updatedAt: NOW, lastEmitAt: NOW - 30_000, watchBuffer: "held 1\nheld 2\n",
    };
    await store.createWakeup(row);
    const sb = sandbox();
    const seam = buildWakeupsSeam({ engineStore: store, limits: LIMITS, now: () => NOW }, "s1", () => ({
      sandbox: sb,
      attachment: { sandboxId: "sb-1", current: () => sb },
    }));
    const prompt = vi.fn(async (_content: PromptContent, _opts: PromptOptions): Promise<unknown> => ({}));
    const session: HumanCancelSession = { options: { wakeups: seam }, prompt, threadById: () => ({}) };

    const result = await cancelWorkAsHuman(store, session, "s1", "wk_w", { actorUserId: "u1", signal: "deliver", now: () => NOW });

    expect(result.kind).toBe("cancelled");
    const content = prompt.mock.calls[0]?.[0];
    const body = typeof content === "object" && content !== null && "body" in content ? String(content.body) : "";
    expect(body).toContain("Last output:\nsent line\n");
    expect(body).toContain("Lines the watch read but did not send yet:\nheld 1\nheld 2\n");
    expect(body.indexOf("Last output")).toBeLessThan(body.indexOf("held 1"));
  });
});
