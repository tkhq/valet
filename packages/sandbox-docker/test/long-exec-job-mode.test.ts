/**
 * Exit-criterion 3-minute case (spec Task 8.2): a real multi-minute exec
 * completes via job mode over the docker provider. The command itself is a
 * fixed `sleep 180`, but the tool timeout and test-level wait budgets are
 * generous (see the comment above `timeout: 480` below) — this dev host runs
 * a k3s cluster plus several unrelated docker-compose stacks that visibly
 * contend for the shared VM's scheduler, and a mostly-idle background
 * container's wall-clock can lag well past its nominal duration under that
 * contention (observed up to ~325s for a 180s sleep). Gated behind
 * VALET_LONG_TESTS=1 in addition to docker-availability — it has no business
 * running by default in the sandbox-docker suite's CI loop. Run explicitly
 * with:
 *
 *   VALET_LONG_TESTS=1 pnpm --filter @valet/sandbox-docker test -- long-exec-job-mode
 *
 * The sub-60s job-mode-selection E2E case lives in
 * packages/engine/test/long-exec-job-mode.test.ts (local provider, ~3s
 * command) — this file only adds the real long-duration wall-clock proof.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Engine, InMemoryEventStream, InMemorySessionStore, type BusEvent } from "@valet/engine";
import { DockerSandboxProvider, createSandboxWorkspace } from "../src/index.js";

let cached: Promise<boolean> | undefined;
function dockerAvailable(): Promise<boolean> {
  if (process.env.VALET_SKIP_DOCKER_TESTS === "1") return Promise.resolve(false);
  if (!cached) {
    cached = new Promise<boolean>((resolvePromise) => {
      const child = spawn("docker", ["info"], { stdio: "ignore" });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolvePromise(false);
      }, 10_000);
      child.on("error", () => {
        clearTimeout(timer);
        resolvePromise(false);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolvePromise(code === 0);
      });
    });
  }
  return cached;
}

async function waitForStatus(
  events: BusEvent[],
  threadId: string,
  status: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = events.some(
        (e) => e.event.type === "status" && e.event.threadId === threadId && e.event.status === status,
      );
      if (found) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for status=${status}`));
      setTimeout(tick, 250);
    };
    tick();
  });
}

const longTestsEnabled = process.env.VALET_LONG_TESTS === "1";

describe.skipIf(!longTestsEnabled || !(await dockerAvailable()))(
  "docker: 3-minute exec via job mode (exit criterion, VALET_LONG_TESTS=1)",
  () => {
    it(
      "sleep 180 && echo done completes via job mode with full output",
      async () => {
        const faux = registerFauxProvider({ provider: "long-exec-3min" });
        faux.setResponses([
          fauxAssistantMessage(
            // `timeout: 480` (8min) is deliberately well past the 180s
            // command duration: this dev host runs a k3s cluster plus
            // several unrelated docker-compose stacks that visibly
            // contend for the shared VM's scheduler, so a mostly-idle
            // background container's wall-clock can lag noticeably
            // (observed: a bare `docker exec sleep 180` completing on time
            // in isolation, but the same command taking ~320s under
            // concurrent host load) — the tool's own job-mode deadline
            // must not race that contention and cancel a job that's still
            // legitimately making progress.
            [fauxToolCall("bash", { command: "sleep 180 && echo done", timeout: 480 }, { id: "tc1" })],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("finished the long run"),
        ]);

        const workspace = await createSandboxWorkspace("valet-long-exec-3min-");
        const provider = new DockerSandboxProvider();
        const store = new InMemorySessionStore();
        const bus = new InMemoryEventStream();
        const events: BusEvent[] = [];
        bus.subscribe({}, (e) => events.push(e));
        const engine = new Engine({ providers: { store, stream: bus, sandboxProvider: provider } });

        const session = await engine.createSession({
          userId: "u1",
          orgId: "o1",
          workspace,
          sandbox: { workspace, image: "alpine:3.20" },
          model: faux.getModel(),
        });

        try {
          const receipt = await session.prompt("run the 3 minute command");
          await waitForStatus(events, receipt.threadId, "idle", 9 * 60_000);

          const entries = await session.readEntries("web:default");
          const assistant = entries.find(
            (e) => e.type === "message" && e.role === "assistant" && e.queueItemId === receipt.queueItemId,
          );
          if (assistant?.type !== "message") throw new Error("unreachable");
          const toolCallPart = assistant.parts?.find((p) => p.type === "tool_call");
          if (toolCallPart?.type !== "tool_call") throw new Error("unreachable");
          expect(toolCallPart.status).toBe("completed");
          const resultObj = toolCallPart.result as { text?: unknown };
          expect(String(resultObj.text ?? "")).toContain("done");
        } finally {
          await session.destroy();
          await rm(workspace, { recursive: true, force: true });
          faux.unregister();
        }
      },
      10 * 60_000,
    );
  },
);
