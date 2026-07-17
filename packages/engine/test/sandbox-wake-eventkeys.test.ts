import { describe, it, expect } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@mariozechner/pi-ai";
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
  type WriteFence,
} from "../src/index.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeFakeSandbox(id: string): Sandbox {
  return {
    id,
    readFile: async () => "content",
    readBinary: async () => new Uint8Array(),
    writeFile: async () => {},
    writeBinary: async () => {},
    readdir: async () => [],
    stat: async () => ({ isFile: true, isDirectory: false, size: 0 }),
    mkdir: async () => {},
    rm: async () => {},
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class HibernatingProvider implements SandboxProvider {
  readonly backend = "fake-hib";
  createCalls = 0;
  private pending: Array<Deferred<Sandbox>> = [];
  private nextId = 1;
  private readonly hibernation: boolean;

  constructor(opts: { hibernation?: boolean } = {}) {
    this.hibernation = opts.hibernation ?? true;
  }

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: true,
      tunnels: false,
      warmPool: false,
      hibernation: this.hibernation,
      coldStartEstimateMs: 5000,
    };
  }

  nextDeferred(): Deferred<Sandbox> {
    const d = defer<Sandbox>();
    this.pending.push(d);
    return d;
  }

  async create(_opts: SandboxCreateOpts): Promise<Sandbox> {
    this.createCalls++;
    const d = this.pending.shift();
    if (!d) return makeFakeSandbox(`sb-${this.nextId++}`);
    return d.promise;
  }
  async restore(id: string): Promise<Sandbox> {
    return makeFakeSandbox(id);
  }
  async destroy(_id: string): Promise<void> {}
  async status(id: string): Promise<SandboxStatus> {
    return { id, state: "ready" };
  }
  async suspend(_id: string): Promise<void> {}
  async resume(_id: string): Promise<void> {}
}

/** Wraps an InMemoryEventStream, recording the eventKey of every append so a
 * test can pin the exact durable keys the engine writes for sandbox_status. */
class KeyRecordingStream extends InMemoryEventStream {
  readonly appended: Array<{ key: string; event: BusEvent }> = [];
  override async append(event: BusEvent, eventKey: string, fence?: WriteFence): Promise<{ offset: string }> {
    const res = await super.append(event, eventKey, fence);
    // Only record keys that actually landed a new row (dedup hits reuse the
    // existing offset but must not double-count here).
    this.appended.push({ key: eventKey, event });
    return res;
  }
}

function makeEngine(sandboxProvider: SandboxProvider) {
  const store = new InMemorySessionStore();
  const bus = new KeyRecordingStream();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, stream: bus, sandboxProvider } });
  return { engine, store, bus, events };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor: timed out");
}

function sandboxKeys(bus: KeyRecordingStream): string[] {
  return bus.appended.filter((a) => a.event.event.type === "sandbox_status").map((a) => a.key);
}

// ── Tests ────────────────────────────────────────────────────────────

describe("sandbox_status wake event keys", () => {
  it("never-suspended flow emits exactly today's keys (byte-identical pin)", async () => {
    const faux = registerFauxProvider({ provider: "wake-pin" });
    faux.setResponses([fauxAssistantMessage("hi")]);

    const provider = new HibernatingProvider();
    const d = provider.nextDeferred();
    const { engine, bus } = makeEngine(provider);

    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
    });

    const receipt = await session.prompt("say hi");
    void receipt;
    d.resolve(makeFakeSandbox("sb-1"));
    await waitFor(() => session.attachment.state === "ready");

    // Exactly the pre-change keys — no `w{n}` segment for a never-suspended box.
    expect(sandboxKeys(bus)).toEqual(["sandbox:1:provisioning", "sandbox:1:ready"]);

    faux.unregister();
  });

  it("suspend→wake emits suspended then distinct-keyed provisioning/ready that ARE appended", async () => {
    const faux = registerFauxProvider({ provider: "wake-cycle" });
    faux.setResponses([fauxAssistantMessage("hi")]);

    const provider = new HibernatingProvider();
    const d = provider.nextDeferred();
    const { engine, bus } = makeEngine(provider);

    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
    });

    await session.prompt("say hi");
    d.resolve(makeFakeSandbox("sb-1"));
    await waitFor(() => session.attachment.state === "ready");

    // Hibernate, then wake — same epoch 1, but wake-tagged keys must not
    // collide with the cold-boot provisioning/ready.
    await session.attachment.suspend();
    await waitFor(() => session.attachment.state === "suspended");
    await session.attachment.ensureReady({ timeoutMs: 5000 });
    await waitFor(() => session.attachment.state === "ready");

    const keys = sandboxKeys(bus);
    expect(keys).toEqual([
      "sandbox:1:provisioning",
      "sandbox:1:ready",
      "sandbox:1:w1:suspended",
      "sandbox:1:w1:provisioning",
      "sandbox:1:w1:ready",
    ]);

    // The wake transitions reached the durable log (no collision drop) and the
    // last durable sandbox_status is `ready`, not the stale `suspended`.
    const { events: log } = await bus.read(session.id);
    const sandboxLog = log.filter((e) => e.event.type === "sandbox_status");
    const last = sandboxLog[sandboxLog.length - 1];
    expect(last?.event.type === "sandbox_status" && last.event.state).toBe("ready");
    expect(
      sandboxLog.some(
        (e) => e.event.type === "sandbox_status" && e.event.state === "provisioning" && e.event.epoch === 1,
      ),
    ).toBe(true);

    faux.unregister();
  });
});
