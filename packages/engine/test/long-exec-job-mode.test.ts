/**
 * Exit-criterion E2E: a long-running bash command (timeout past the 60s
 * job-mode threshold) actually completes via the job path end-to-end
 * through Engine -> Session -> Thread -> bashTool -> PolicySandbox -> the
 * real LocalSandboxProvider, not just the tool's unit-level mode-selection
 * logic (that's covered separately in bash-job-mode.test.ts).
 *
 * The command only sleeps ~3s (not 60s+) — the point being tested is mode
 * *selection* (timeout param past JOB_MODE_THRESHOLD_MS triggers job mode
 * regardless of how long the command actually takes), not wall-clock
 * duration. A real multi-minute case is docker-gated separately in
 * @valet/sandbox-docker under VALET_LONG_TESTS=1 (see
 * packages/sandbox-docker/test/long-exec-job-mode.test.ts) — that lives in
 * the docker package because it needs the package's docker-availability
 * gating machinery, and a 3-minute wall-clock test has no business running
 * by default in the engine suite's CI loop.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { LocalSandboxProvider } from "@valet/sandbox-local";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  type BusEvent,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxCreateOpts,
  type SandboxProvider,
  type SandboxStatus,
} from "../src/index.js";

/** Wraps LocalSandboxProvider, monkey-patching each created sandbox's
 * `execJob` with a call counter so the test can assert the job path (not
 * sync exec) was actually taken end-to-end. */
class SpyingLocalProvider implements SandboxProvider {
  readonly backend: string;
  execJobCalls = 0;
  execCalls = 0;
  private inner = new LocalSandboxProvider();

  constructor() {
    this.backend = this.inner.backend;
  }

  capabilities(): SandboxCapabilities {
    return this.inner.capabilities();
  }

  async create(opts: SandboxCreateOpts): Promise<Sandbox> {
    const sb = await this.inner.create(opts);
    const origExecJob = sb.execJob?.bind(sb);
    const origExec = sb.exec.bind(sb);
    if (origExecJob) {
      sb.execJob = async (...args: Parameters<NonNullable<Sandbox["execJob"]>>) => {
        this.execJobCalls++;
        return origExecJob(...args);
      };
    }
    sb.exec = async (...args: Parameters<Sandbox["exec"]>) => {
      this.execCalls++;
      return origExec(...args);
    };
    return sb;
  }

  async restore(id: string): Promise<Sandbox> {
    return this.inner.restore(id);
  }

  async destroy(id: string): Promise<void> {
    return this.inner.destroy(id);
  }

  async status(id: string): Promise<SandboxStatus> {
    return this.inner.status(id);
  }
}

function makeEngine(sandboxProvider: SandboxProvider) {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, stream: bus, sandboxProvider } });
  return { engine, bus, events };
}

async function waitForStatus(
  events: BusEvent[],
  threadId: string,
  status: string,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = events.some(
        (e) => e.event.type === "status" && e.event.threadId === threadId && e.event.status === status,
      );
      if (found) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for status=${status}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("long exec via job mode (exit criterion, local provider E2E)", () => {
  it("timeout:61 over a real LocalSandboxProvider takes the job path and returns full output", async () => {
    const faux = registerFauxProvider({ provider: "long-exec-job" });
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("bash", { command: "sleep 3 && echo all-done-here", timeout: 61 }, { id: "tc1" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("finished"),
    ]);

    const workspace = await mkdtemp(join(tmpdir(), "valet-long-exec-job-"));
    const provider = new SpyingLocalProvider();
    const { engine, events } = makeEngine(provider);

    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace,
      sandbox: { workspace },
      model: faux.getModel(),
    });

    try {
      const receipt = await session.prompt("run the long command");
      await waitForStatus(events, receipt.threadId, "idle", 20_000);
      const entries = await session.readEntries("web:default");
      const assistant = entries.find(
        (e) => e.type === "message" && e.role === "assistant" && e.queueItemId === receipt.queueItemId,
      );
      if (assistant?.type !== "message") throw new Error("unreachable");
      const toolCallPart = assistant.parts?.find((p) => p.type === "tool_call");
      if (toolCallPart?.type !== "tool_call") throw new Error("unreachable");

      expect(provider.execJobCalls).toBe(1);
      expect(provider.execCalls).toBe(0);
      expect(toolCallPart.status).toBe("completed");
      const resultObj = toolCallPart.result as { text?: unknown };
      expect(String(resultObj.text ?? "")).toContain("all-done-here");
    } finally {
      await session.destroy();
      await rm(workspace, { recursive: true, force: true });
      faux.unregister();
    }
  }, 30_000);
});
