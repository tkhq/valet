import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
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
} from "@valet/engine";
import { DockerSandbox, DockerSandboxProvider } from "../src/index.js";

/**
 * Memoized `docker info` probe (10s timeout) — same idiom as
 * sandbox-contract.test.ts (spec decision 11), honoring
 * VALET_SKIP_DOCKER_TESTS=1 as an explicit escape hatch.
 */
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

/**
 * Wraps DockerSandboxProvider, capturing the exact containerId of the raw
 * sandbox it creates. `docker ps --filter name=valet-sandbox-` was tried
 * first but is unsafe here: this suite's OTHER test files
 * (docker-sandbox.test.ts, sandbox-contract.test.ts) run concurrently in
 * the same vitest process and create their own `valet-sandbox-*`
 * containers via the same provider — a "first container not in my
 * baseline" diff can pick up a sibling test's container and kill the
 * wrong one, letting this test's own exec run to completion untouched
 * (observed: intermittent false-negative failures only under full-suite
 * concurrency, never in file isolation). Capturing the containerId
 * directly off the created `DockerSandbox` instance is race-free.
 */
class CapturingDockerProvider implements SandboxProvider {
  readonly backend: string;
  private inner = new DockerSandboxProvider();
  lastContainerId: string | undefined;

  constructor() {
    this.backend = this.inner.backend;
  }

  capabilities(): SandboxCapabilities {
    return this.inner.capabilities();
  }

  async create(opts: SandboxCreateOpts): Promise<Sandbox> {
    const sb = await this.inner.create(opts);
    if (sb instanceof DockerSandbox) this.lastContainerId = sb.containerId;
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

function dockerRmForce(id: string): Promise<void> {
  return new Promise((resolvePromise) => {
    const child = spawn("docker", ["rm", "-f", id]);
    child.on("close", () => resolvePromise());
    child.on("error", () => resolvePromise());
  });
}

// Generous defaults: this dev host runs other docker-compose stacks +
// a k3s cluster that visibly contend with the sandbox-docker suite's own
// concurrently-running test files for the shared daemon, so container
// create/exec latency is not solely a function of this test's own work.
async function waitForAsync(predicate: () => Promise<boolean> | boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitForAsync: timed out");
}

async function waitForStatus(
  events: BusEvent[],
  threadId: string,
  status: string,
  timeoutMs = 45_000,
  fromIndex = 0,
): Promise<void> {
  await waitForAsync(
    () =>
      events
        .slice(fromIndex)
        .some((e) => e.event.type === "status" && e.event.threadId === threadId && e.event.status === status),
    timeoutMs,
  );
}

interface MakeSessionOpts {
  provider: SandboxProvider;
  workspace: string;
}

function makeEngine({ provider, workspace }: MakeSessionOpts) {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, stream: bus, sandboxProvider: provider } });
  return { engine, bus, events, workspace };
}

describe.skipIf(!(await dockerAvailable()))("docker: kill-container-mid-exec recovery (exit criteria)", () => {
  it(
    "sandbox_unavailable tool error, submission settles completed (not failed), epoch 2 reprovisions, recovery succeeds",
    async () => {
      const faux = registerFauxProvider({ provider: "kill-recovery" });
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30", timeout: 45 }, { id: "tc1" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("the sandbox errored; ending this turn"),
        fauxAssistantMessage([fauxToolCall("bash", { command: "echo recovered", timeout: 10 }, { id: "tc2" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("confirmed recovery"),
      ]);

      const workspace = await mkdtemp(join(tmpdir(), "valet-kill-recovery-"));
      const provider = new CapturingDockerProvider();
      const { engine, bus, events } = makeEngine({ provider, workspace });

      const session = await engine.createSession({
        userId: "u1",
        orgId: "o1",
        workspace,
        sandbox: { workspace, image: "alpine:3.20" },
        model: faux.getModel(),
      });

      try {
        const receipt = await session.prompt("run a long sleep");

        // Let the container come up and the `docker exec sleep 30` actually
        // get issued and attach before yanking the container out from under it.
        await waitForAsync(() => provider.lastContainerId !== undefined);
        const containerId = provider.lastContainerId;
        if (!containerId) throw new Error("unreachable: containerId captured by waitForAsync above");
        await new Promise((r) => setTimeout(r, 1500));
        await dockerRmForce(containerId);

        await waitForStatus(events, receipt.threadId, "idle");

        const entries = await session.readEntries("web:default");
        const assistant = entries.find(
          (e) => e.type === "message" && e.role === "assistant" && e.queueItemId === receipt.queueItemId,
        );
        if (assistant?.type !== "message") throw new Error("unreachable");
        const toolCallPart = assistant.parts?.find((p) => p.type === "tool_call");
        if (toolCallPart?.type !== "tool_call") throw new Error("unreachable");
        expect(toolCallPart.status).toBe("error");
        const resultObj = toolCallPart.result as { text?: unknown };
        expect(String(resultObj.text ?? "")).toContain("[sandbox_unavailable]");

        // Decision 14: degradation must NEVER settle a submission failed —
        // the turn runs to normal completion via the model's own text response.
        await waitForAsync(async () => {
          const { events: log } = await bus.read(session.id);
          const settled = log.find(
            (e) => e.event.type === "submission_settled" && e.event.queueItemId === receipt.queueItemId,
          );
          return (
            settled !== undefined &&
            settled.event.type === "submission_settled" &&
            settled.event.outcome.outcome === "completed"
          );
        }, 15_000);

        // Background re-provision to epoch 2, observable via sandbox_status.
        await waitForAsync(() => session.attachment.currentEpoch() >= 2, 30_000);
        await waitForAsync(() => session.attachment.state === "ready", 60_000);

        const { events: log } = await bus.read(session.id);
        const epoch2 = log.filter((e) => e.event.type === "sandbox_status" && e.event.epoch === 2);
        expect(
          epoch2.some((e) => e.event.type === "sandbox_status" && e.event.state === "provisioning"),
        ).toBe(true);
        expect(epoch2.some((e) => e.event.type === "sandbox_status" && e.event.state === "ready")).toBe(true);

        // Follow-up prompt succeeds against the newly-provisioned container.
        const fromIndex = events.length;
        const receipt2 = await session.prompt("run echo recovered");
        await waitForStatus(events, receipt2.threadId, "idle", 45_000, fromIndex);

        const entries2 = await session.readEntries("web:default");
        const assistant2 = entries2.find(
          (e) => e.type === "message" && e.role === "assistant" && e.queueItemId === receipt2.queueItemId,
        );
        if (assistant2?.type !== "message") throw new Error("unreachable");
        const toolCallPart2 = assistant2.parts?.find((p) => p.type === "tool_call");
        if (toolCallPart2?.type !== "tool_call") throw new Error("unreachable");
        expect(toolCallPart2.status).toBe("completed");
        const resultObj2 = toolCallPart2.result as { text?: unknown };
        expect(String(resultObj2.text ?? "")).toContain("recovered");
      } finally {
        await session.destroy();
        await rm(workspace, { recursive: true, force: true });
        faux.unregister();
      }
    },
    180_000,
  );

  it(
    "cold-start (docker variant): first durable message_start precedes attachment-ready",
    async () => {
      const faux = registerFauxProvider({ provider: "coldstart-docker" });
      faux.setResponses([fauxAssistantMessage("hello, no tools needed")]);

      const workspace = await mkdtemp(join(tmpdir(), "valet-coldstart-docker-"));
      const provider = new DockerSandboxProvider();
      const { engine, bus, events } = makeEngine({ provider, workspace });

      const session = await engine.createSession({
        userId: "u1",
        orgId: "o1",
        workspace,
        sandbox: { workspace, image: "alpine:3.20" },
        model: faux.getModel(),
      });

      try {
        const receipt = await session.prompt("say hi, no tools");
        await waitForStatus(events, receipt.threadId, "idle");
        // The no-tool turn can finish (idle) well before the background
        // warm-kicked container actually becomes ready — wait for that too
        // so the durable sandbox_status:ready event has actually landed.
        await waitForAsync(() => session.attachment.state === "ready", 30_000);

        const { events: log } = await bus.read(session.id);
        const messageStart = log.find(
          (e) => e.event.type === "message_start" && e.event.threadId === receipt.threadId,
        );
        const ready = log.find(
          (e) => e.event.type === "sandbox_status" && e.event.state === "ready" && e.event.epoch === 1,
        );
        expect(messageStart).toBeDefined();
        expect(ready).toBeDefined();
        expect(messageStart!.timestamp).toBeLessThan(ready!.timestamp);
      } finally {
        await session.destroy();
        await rm(workspace, { recursive: true, force: true });
        faux.unregister();
      }
    },
    90_000,
  );
});
