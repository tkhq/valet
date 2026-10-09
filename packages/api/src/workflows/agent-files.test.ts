import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualSandboxProvider, WorkspaceProvisioningError } from "@valet/engine";
import { fauxAssistantMessage, registerFauxProvider } from "@valet/engine/test-helpers";
import { createDefaultNodeExecutors, driveUntilPark, MAX_AGENT_INPUT_FILE_BYTES, type WorkflowDefinition, type WorkflowNode, type RunHost } from "@valet/workflow";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { buildWorkflowEngineDeps, cleanupWorkflowRunInputs, ensureWorkflowSession } from "./engine-deps.js";
import { AGENT_INPUT_RETENTION_MS, AGENT_INPUT_SWEEP_LIMIT, cleanupAgentInputFiles, sweepAgentInputFiles, writeAgentInputFiles } from "./agent-files.js";
import { ensureDefaultAssistantSession, resolveDefaultAssistant } from "../assistants/service.js";
import * as inputMetrics from "../observability/workflow-input-metrics.js";
import { workflowDefinitions } from "../schema/index.js";
import { LOCAL_ORG, LOCAL_USER } from "../providers/node.js";

let api: TestApi | undefined;
let faux: ReturnType<typeof registerFauxProvider> | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  faux?.unregister();
  faux = undefined;
  vi.unstubAllEnvs();
});

const inert: RunHost = { start: async () => {}, wake: async () => {}, terminate: async () => {}, scheduleWake: async () => {}, startHost: () => {}, stopHost: async () => {} };

async function setup(node: WorkflowNode, policy?: WorkflowDefinition["policy"], provider = new VirtualSandboxProvider(), next?: WorkflowNode) {
  vi.stubEnv("ANTHROPIC_API_KEY", "faux-key");
  faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
  api = await bootTestApi({ workflowRunHost: inert, sandboxProvider: provider });
  const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
  const definition: WorkflowDefinition = { version: "dag/v1", nodes: [{ id: "t", type: "trigger" }, node, ...(next ? [next] : [])], edges: [{ from: "t", to: node.id }, ...(next ? [{ from: node.id, to: next.id }] : [])], ...(policy ? { policy } : {}) };
  await db.insert(workflowDefinitions).values({ id: "files-wf", orgId: LOCAL_ORG.id, ownerType: "user", ownerId: LOCAL_USER.id, name: "Files", definition, createdAt: Date.now(), updatedAt: Date.now() });
  const opts = { host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials };
  const engine = buildWorkflowEngineDeps(opts);
  const createRun = async (id: string) => {
    await workflowStore.createRun(id, { workflowId: "files-wf", definitionVersionId: "v1", input: { type: "manual", timestamp: "now", data: { jobs: [{ id: 17, title: "héllo" }], rows: ["alpha", "beta"] }, metadata: {} } }, definition, "v1", { ownerType: "user", ownerId: LOCAL_USER.id });
    const claim = await workflowStore.claimRun(id, "files-test", 60_000);
    if (!claim) throw new Error("Could not claim test run");
    return claim.attempt;
  };
  const drive = (id: string, attempt: number) => driveUntilPark(id, attempt, { store: workflowStore, engine, clock: Date.now, executors: createDefaultNodeExecutors(), onRunSettled: info => cleanupWorkflowRunInputs(opts, info.runId) });
  return { ...api.providers, opts, engine, createRun, drive };
}

const inputRoot = (run: string, node = "build", iteration = 0) => `/workspace/.valet/workflow-inputs/${run}/${node}/${iteration}`;

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block: unknown) => block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "").join("");
}

describe("workflow sandbox input dispatch", () => {
  it("writes exact bytes before the first model call, appends a manifest, and keeps checkpoints content-free", async () => {
    const h = await setup({ id: "build", type: "session", mode: "start", prompt: "Read input files.", files: { "nested/jobs.json": "{{trigger.data.jobs}}", "notes.md": "héllo\n" } });
    const attempt = await h.createRun("files-run");
    const observed: Array<{ text: string; jobs: string; notes: string }> = [];
    faux?.setResponses([async (ctx) => {
      const session = h.engineHost.liveSession("wf:files-run:build");
      const sandbox = session?.attachment.current();
      if (!sandbox) throw new Error("Sandbox must exist at the first model call");
      observed.push({ text: messageText(ctx.messages.find((m) => m.role === "user")?.content), jobs: await sandbox.readFile(`${inputRoot("files-run")}/nested/jobs.json`), notes: await sandbox.readFile(`${inputRoot("files-run")}/notes.md`) });
      return fauxAssistantMessage("Read inputs");
    }]);
    const parked = await h.drive("files-run", attempt);
    expect(parked.status).toBe("parked");
    await vi.waitFor(() => expect(observed).toHaveLength(1), { timeout: 15_000 });
    const jobs = JSON.stringify([{ id: 17, title: "héllo" }], null, 2);
    expect(observed[0].jobs).toBe(jobs);
    expect(observed[0].notes).toBe("héllo\n");
    expect(observed[0].text).toContain("Read input files.\n\nWorkflow input files:");
    expect(observed[0].text).toContain(`${inputRoot("files-run")}/nested/jobs.json (${Buffer.byteLength(jobs)} bytes)`);
    expect(observed[0].text).toContain("notes.md (7 bytes)");
    const checkpoint = (await h.workflowStore.getCheckpoints("files-run")).find((cp) => cp.nodeId === "build");
    expect(Object.keys(checkpoint?.effects ?? {}).sort()).toEqual(["receipt", "repairAttempted", "sessionId"]);
    await vi.waitFor(async () => {
      const cp = (await h.workflowStore.getCheckpoints("files-run")).find((row) => row.nodeId === "build");
      const receipt = cp?.effects?.receipt;
      if (!receipt || typeof receipt !== "object" || !("queueItemId" in receipt) || typeof receipt.queueItemId !== "string") throw new Error("Missing receipt");
      expect(await h.engine.isSettled("wf:files-run:build", receipt.queueItemId)).toBe(true);
    }, { timeout: 15_000 });
    expect((await h.drive("files-run", attempt)).outcome).toBe("completed");
    expect(faux?.state.callCount).toBe(1);
  });

  it("writes foreach inputs before consumption and cleans each iteration on settlement", async () => {
    const h = await setup({ id: "fan", type: "foreach", items: "{{trigger.data.rows}}", concurrency: 2, body: { id: "build", type: "session", mode: "start", prompt: "Read", files: { "item.txt": "{{item}}", "index.json": "{{index}}" } } });
    const observed: string[] = [];
    const inspect: import("@valet/engine/test-helpers").FauxResponseStep = async ctx => {
      const text = messageText(ctx.messages.find(m => m.role === "user")?.content);
      const i = text.includes("/build/1/") ? 1 : 0;
      const session = await ensureWorkflowSession(h.opts, `wf:foreach-run:build${i ? `:${i}` : ""}`);
      const sandbox = session.attachment.current();
      expect(await sandbox?.readFile(`${inputRoot("foreach-run", "build", i)}/index.json`)).toBe(String(i));
      observed.push(await sandbox!.readFile(`${inputRoot("foreach-run", "build", i)}/item.txt`));
      return fauxAssistantMessage("ok");
    };
    faux?.setResponses([inspect, inspect]);
    const attempt = await h.createRun("foreach-run");
    await h.drive("foreach-run", attempt);
    await vi.waitFor(async () => expect((await h.drive("foreach-run", attempt)).outcome).toBe("completed"), { timeout: 15_000 });
    expect(observed.sort()).toEqual(["alpha", "beta"]);
    for (const i of [0, 1]) {
      const session = await ensureWorkflowSession(h.opts, `wf:foreach-run:build${i ? `:${i}` : ""}`);
      await expect(session.attachment.current()?.stat(inputRoot("foreach-run", "build", i))).rejects.toThrow("ENOENT");
    }
  });

  it("scopes two orchestrator runs in the shared assistant sandbox without collisions", async () => {
    const h = await setup({ id: "build", type: "orchestrator", prompt: "Read", files: { "jobs.json": "{{trigger.data.jobs}}" } });
    const observed: string[] = [];
    const inspect: import("@valet/engine/test-helpers").FauxResponseStep = async (ctx) => {
      const prompt = messageText(ctx.messages.find((m) => m.role === "user")?.content);
      const path = /- (\/workspace\/\S+) \(\d+ bytes\)/.exec(prompt)?.[1];
      if (!path) throw new Error("Missing manifest at the first orchestrator model call");
      const runId = path.includes("run-one") ? "run-one" : "run-two";
      const assistant = await resolveDefaultAssistant(h.db, LOCAL_ORG.id, { type: "user", id: LOCAL_USER.id });
      const sandbox = h.engineHost.liveSession(assistant.sessionId)?.attachment.current();
      if (!sandbox) throw new Error("Cold assistant sandbox must be ready before the first turn");
      expect(await sandbox.readFile(path)).toBe(JSON.stringify([{ id: 17, title: "héllo" }], null, 2));
      observed.push(runId);
      return fauxAssistantMessage("Read inputs");
    };
    faux?.setResponses([inspect, inspect]);
    for (const runId of ["run-one", "run-two"]) {
      const attempt = await h.createRun(runId);
      expect((await h.drive(runId, attempt)).status).toBe("parked");
    }
    await vi.waitFor(() => expect(observed.sort()).toEqual(["run-one", "run-two"]), { timeout: 15_000 });
    const checkpoints = await Promise.all(["run-one", "run-two"].map(async (runId) => (await h.workflowStore.getCheckpoints(runId)).find((cp) => cp.nodeId === "build")));
    expect(checkpoints[0]?.effects?.sessionId).toBe(checkpoints[1]?.effects?.sessionId);
    const id = checkpoints[0]?.effects?.sessionId;
    if (typeof id !== "string") throw new Error("Missing assistant session");
    const sandbox = h.engineHost.liveSession(id)?.attachment.current();
    for (const runId of ["run-one", "run-two"]) {
      expect(await sandbox?.readFile(`${inputRoot(runId)}/jobs.json`)).toBe(JSON.stringify([{ id: 17, title: "héllo" }], null, 2));
    }
  });

  it.each(["session", "orchestrator"] as const)("lost-receipt %s replay ignores edited or deleted inputs", async type => {
    const h = await setup({ id: "build", type: "session", mode: "start", prompt: "Read" });
    await h.createRun("retry-run");
    faux?.setResponses([fauxAssistantMessage("ok")]);
    const options = { dispatchId: "workflow:retry-run:build", files: [{ path: "data.txt", content: "v1" }] };
    const submit = (content: string) => type === "session"
      ? h.engine.prompt("wf:retry-run:build", "Read", { ...options, files: [{ path: "data.txt", content }] })
      : h.engine.promptOrchestrator("Read", { ...options, files: [{ path: "data.txt", content }], queueMode: "followup", ownerHint: { ownerType: "user", ownerId: LOCAL_USER.id } });
    const first = await submit("v1");
    const id = "sessionId" in first && typeof first.sessionId === "string" ? first.sessionId : "wf:retry-run:build";
    await vi.waitFor(async () => expect(await h.engine.isSettled(id, first.queueItemId)).toBe(true), { timeout: 15_000 });
    const sandbox = h.engineHost.liveSession(id)?.attachment.current();
    if (!sandbox) throw new Error("Missing sandbox");
    const write = vi.spyOn(sandbox, "writeBinary");
    expect(await submit("v1")).toEqual(first);
    await sandbox.writeFile(`${inputRoot("retry-run")}/data.txt`, "agent changed the input");
    write.mockClear();
    const read = vi.spyOn(sandbox, "readBinary");
    expect(await submit("v1")).toEqual(first);
    await sandbox.rm(`${inputRoot("retry-run")}/data.txt`);
    expect(await submit("v1")).toEqual(first);
    const file = vi.spyOn(sandbox, "readFile");
    const list = vi.spyOn(sandbox, "readdir");
    const stat = vi.spyOn(sandbox, "stat");
    const exec = vi.spyOn(sandbox, "exec");
    const ready = vi.spyOn(h.engineHost.liveSession(id)!.attachment, "ensureReady");
    expect(await submit("v1")).toEqual(first);
    expect(read).not.toHaveBeenCalled();
    expect(file).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(faux?.state.callCount).toBe(1);
  });

  it.each(["provisioning", "readiness timeout", "transport"])("retries a one-time %s failure and completes the node", async kind => {
    const h = await setup({ id: "build", type: "session", mode: "start", prompt: "Read", files: { "data.txt": "v1" } });
    const attempt = await h.createRun("transient-run");
    const session = await ensureWorkflowSession(h.opts, "wf:transient-run:build");
    const error = kind === "provisioning" ? new WorkspaceProvisioningError(1) : new Error(kind);
    if (kind === "transport") {
      const { sandbox } = await session.attachment.ensureReady({ timeoutMs: 5_000 });
      vi.spyOn(sandbox, "writeBinary").mockRejectedValueOnce(error);
    } else vi.spyOn(session.attachment, "ensureReady").mockRejectedValueOnce(error);
    faux?.setResponses([fauxAssistantMessage("ok")]);
    await expect(h.drive("transient-run", attempt)).rejects.toBe(error);
    expect((await h.workflowStore.getCheckpoints("transient-run")).find(cp => cp.nodeId === "build")?.status).toBe("intent");
    expect((await h.drive("transient-run", attempt)).status).toBe("parked");
    await vi.waitFor(async () => expect((await h.drive("transient-run", attempt)).outcome).toBe("completed"), { timeout: 15_000 });
    expect(faux?.state.callCount).toBe(1);
    await expect(session.attachment.current()?.stat(inputRoot("transient-run"))).rejects.toThrow("ENOENT");
  });

  it("repairs a truncated transport write before admission on the next drive", async () => {
    const h = await setup({ id: "build", type: "session", mode: "start", prompt: "Read", files: { "data.txt": "0123456789" } });
    const attempt = await h.createRun("partial-run");
    const session = await ensureWorkflowSession(h.opts, "wf:partial-run:build");
    const { sandbox } = await session.attachment.ensureReady({ timeoutMs: 5_000 });
    const original = sandbox.writeBinary.bind(sandbox);
    let truncated = false;
    vi.spyOn(sandbox, "writeBinary").mockImplementation(async (path, bytes) => {
      if (path.includes("data.txt") && !truncated) {
        truncated = true;
        await original(path, bytes.slice(0, 4));
        throw new Error("transport lost after four bytes");
      }
      await original(path, bytes);
    });
    faux?.setResponses([async () => {
      expect(await sandbox.readFile(`${inputRoot("partial-run")}/data.txt`)).toBe("0123456789");
      return fauxAssistantMessage("ok");
    }]);
    await expect(h.drive("partial-run", attempt)).rejects.toThrow("transport lost");
    expect((await h.workflowStore.getCheckpoints("partial-run")).find(cp => cp.nodeId === "build"))
      .toMatchObject({ status: "intent", effects: { inputFilesAttempted: true, sessionId: session.id } });
    expect(faux?.state.callCount).toBe(0);
    await h.drive("partial-run", attempt);
    await vi.waitFor(async () => expect((await h.drive("partial-run", attempt)).outcome).toBe("completed"), { timeout: 15_000 });
    expect(faux?.state.callCount).toBe(1);
  });

  it("cleans deterministic orchestrator mid-write failure using executor-owned intent", async () => {
    const h = await setup({ id: "build", type: "orchestrator", prompt: "Read", files: { "one.txt": "one", "two.txt": "two" } });
    const attempt = await h.createRun("partial-failure");
    const { session } = await ensureDefaultAssistantSession(h, { type: "user", id: LOCAL_USER.id }, { actorUserId: LOCAL_USER.id, orgId: LOCAL_ORG.id });
    const { sandbox } = await session.attachment.ensureReady({ timeoutMs: 5_000 });
    const original = sandbox.writeBinary.bind(sandbox);
    vi.spyOn(sandbox, "writeBinary").mockImplementation(async (path, bytes) => {
      if (path.includes("two.txt")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      await original(path, bytes);
    });
    expect((await h.drive("partial-failure", attempt)).outcome).toBe("failed");
    expect((await h.workflowStore.getCheckpoints("partial-failure")).find(cp => cp.nodeId === "build"))
      .toMatchObject({ status: "failed", effects: { sessionId: session.id, inputFilesAttempted: true } });
    await expect(sandbox.stat("/workspace/.valet/workflow-inputs/partial-failure")).rejects.toThrow("ENOENT");
    expect(faux?.state.callCount).toBe(0);
  });

  it("aborts active input reading before cancellation cleanup", async () => {
    const h = await setup({ id: "build", type: "orchestrator", prompt: "Read", files: { "data.txt": "v1" } });
    const attempt = await h.createRun("reading-cancel");
    let reading = false;
    let aborted = false;
    faux?.setResponses([async (_ctx, options) => {
      const { session } = await ensureDefaultAssistantSession(h, { type: "user", id: LOCAL_USER.id }, { actorUserId: LOCAL_USER.id, orgId: LOCAL_ORG.id });
      expect(await session.attachment.current()?.readFile(`${inputRoot("reading-cancel")}/data.txt`)).toBe("v1");
      reading = true;
      await new Promise<void>(resolve => {
        if (options?.signal?.aborted) { aborted = true; resolve(); }
        else options?.signal?.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
      });
      return fauxAssistantMessage("aborted");
    }]);
    await h.drive("reading-cancel", attempt);
    await vi.waitFor(() => expect(reading).toBe(true), { timeout: 15_000 });
    await h.workflowStore.insertSignal({ runId: "reading-cancel", signalId: "cancel", signalType: "cancel", createdAt: Date.now() });
    expect((await h.drive("reading-cancel", attempt)).outcome).toBe("cancelled");
    expect(aborted).toBe(true);
    const assistant = await resolveDefaultAssistant(h.db, LOCAL_ORG.id, { type: "user", id: LOCAL_USER.id });
    await expect(h.engineHost.liveSession(assistant.sessionId)?.attachment.current()?.stat(inputRoot("reading-cancel"))).rejects.toThrow("ENOENT");
  });

  it("cleanup never provisions detached or uncached sessions and skips workflow run sandboxes", async () => {
    const provider = new VirtualSandboxProvider();
    const h = await setup({ id: "build", type: "session", mode: "start", prompt: "Read" }, undefined, provider);
    const attempt = await h.createRun("cold-cleanup");
    const session = await ensureWorkflowSession(h.opts, "wf:cold-cleanup:build");
    const ready = vi.spyOn(session.attachment, "ensureReady");
    const create = vi.spyOn(provider, "create");
    const skipped = vi.spyOn(inputMetrics, "recordWorkflowInputCleanupSkipped");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await h.engine.cleanupAgentInputs?.(session.id, "workflow:cold-cleanup:build");
    await h.workflowStore.putIntent({ runId: "cold-cleanup", nodeId: "build", iteration: 0, status: "intent", attempt, createdAt: Date.now(), effects: { sessionId: session.id, inputFilesAttempted: true } });
    await cleanupWorkflowRunInputs(h.opts, "cold-cleanup");
    h.engineHost.evictCache(session.id);
    await h.engine.cleanupAgentInputs?.(session.id, "workflow:cold-cleanup:build");
    expect(ready).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(skipped).toHaveBeenCalledWith("node", "detached");
    expect(skipped).toHaveBeenCalledWith("node", "uncached");
    expect(warn).toHaveBeenCalledWith("workflow input cleanup skipped", expect.objectContaining({ scope: "node", reason: "uncached" }));
    skipped.mockRestore();
    warn.mockRestore();
  });

  it("cleanup does not wake a suspended assistant sandbox", async () => {
    class HibernatingProvider extends VirtualSandboxProvider {
      async suspend(_id: string): Promise<void> {}
      async resume(id: string) { return this.restore(id); }
    }
    const provider = new HibernatingProvider();
    const h = await setup({ id: "build", type: "orchestrator", prompt: "Read" }, undefined, provider);
    await h.createRun("suspended-cleanup");
    const { session } = await ensureDefaultAssistantSession(h, { type: "user", id: LOCAL_USER.id }, { actorUserId: LOCAL_USER.id, orgId: LOCAL_ORG.id });
    const { sandbox } = await session.attachment.ensureReady({ timeoutMs: 5_000 });
    await sandbox.mkdir(inputRoot("suspended-cleanup"));
    await session.attachment.suspend();
    const resume = vi.spyOn(provider, "resume");
    const ready = vi.spyOn(session.attachment, "ensureReady");
    await h.engine.cleanupAgentInputs?.(session.id, "workflow:suspended-cleanup:build");
    expect(session.attachment.state).toBe("suspended");
    expect(resume).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect((await sandbox.stat(inputRoot("suspended-cleanup"))).isDirectory).toBe(true);
  });

  it("cleans a settled node while the run is parked, then cleans the run on cancellation", async () => {
    const h = await setup({ id: "build", type: "orchestrator", prompt: "Read", files: { "data.txt": "v1" } }, undefined, new VirtualSandboxProvider(), { id: "pause", type: "wait", mode: "duration", duration: "1h" });
    faux?.setResponses([fauxAssistantMessage("ok")]);
    const attempt = await h.createRun("node-cleanup");
    await h.drive("node-cleanup", attempt);
    await vi.waitFor(async () => {
      await h.drive("node-cleanup", attempt);
      expect((await h.workflowStore.getCheckpoints("node-cleanup")).find(cp => cp.nodeId === "build")?.status).toBe("completed");
    }, { timeout: 15_000 });
    const cp = (await h.workflowStore.getCheckpoints("node-cleanup")).find(cp => cp.nodeId === "build");
    const sandbox = typeof cp?.effects?.sessionId === "string" ? h.engineHost.liveSession(cp.effects.sessionId)?.attachment.current() : undefined;
    if (!sandbox) throw new Error("Missing sandbox");
    await expect(sandbox.stat(inputRoot("node-cleanup"))).rejects.toThrow("ENOENT");
    expect((await sandbox.stat("/workspace/.valet/workflow-inputs/node-cleanup")).isDirectory).toBe(true);
    await h.workflowStore.insertSignal({ runId: "node-cleanup", signalId: "cancel", signalType: "cancel", createdAt: Date.now() });
    expect((await h.drive("node-cleanup", attempt)).outcome).toBe("cancelled");
    await expect(sandbox.stat("/workspace/.valet/workflow-inputs/node-cleanup")).rejects.toThrow("ENOENT");
  });

  it("contains sweep failures and still delivers the current input", async () => {
    const h = await setup({ id: "build", type: "session", mode: "start", prompt: "Read" });
    await h.createRun("sweep-error");
    const session = await ensureWorkflowSession(h.opts, "wf:sweep-error:build");
    const { sandbox } = await session.attachment.ensureReady({ timeoutMs: 5_000 });
    const old = "/workspace/.valet/workflow-inputs/old";
    await sandbox.mkdir(old);
    await sandbox.writeFile(`${old}/.created-at`, "1");
    const originalRm = sandbox.rm.bind(sandbox);
    vi.spyOn(sandbox, "rm").mockImplementation((path, opts) => path === old ? Promise.reject(new Error("transport down")) : originalRm(path, opts));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await writeAgentInputFiles(session, "/workspace", "Read", { dispatchId: "workflow:sweep-error:build", files: [{ path: "data.txt", content: "v1" }] }, h.db);
      expect(await sandbox.readFile(`${inputRoot("sweep-error")}/data.txt`)).toBe("v1");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("sweep failed"), expect.any(Error));
    } finally { warn.mockRestore(); }
  });

  it.each(["completed", "failed", "cancelled"] as const)("cleans the full run directory on %s without touching sibling runs", async outcome => {
    const h = await setup({ id: "build", type: "orchestrator", prompt: "Read", files: { "data.txt": "v1" } });
    const attempt = await h.createRun("cleanup-run");
    const { session } = await ensureDefaultAssistantSession(h, { type: "user", id: LOCAL_USER.id }, { actorUserId: LOCAL_USER.id, orgId: LOCAL_ORG.id });
    await h.workflowStore.putIntent({ runId: "cleanup-run", nodeId: "build", iteration: 0, status: "intent", attempt, createdAt: Date.now(), effects: { sessionId: session.id, inputFilesAttempted: true } });
    for (const run of ["cleanup-run", "sibling-run"]) {
      await writeAgentInputFiles(session, "/workspace", "Read", { dispatchId: `workflow:${run}:build`, files: [{ path: "data.txt", content: "v1" }] }, h.db);
    }
    await h.workflowStore.beginTerminalize("cleanup-run", attempt, outcome);
    await h.workflowStore.settleRun("cleanup-run", outcome);
    await cleanupWorkflowRunInputs(h.opts, "cleanup-run");
    const sandbox = session.attachment.current();
    await expect(sandbox?.stat("/workspace/.valet/workflow-inputs/cleanup-run")).rejects.toThrow("ENOENT");
    expect(await sandbox?.readFile(`${inputRoot("sibling-run")}/data.txt`)).toBe("v1");
  });

  it("logs cleanup failure without changing settlement", async () => {
    const h = await setup({ id: "build", type: "session", mode: "start", prompt: "Read" });
    await h.createRun("cleanup-error");
    const session = await ensureWorkflowSession(h.opts, "wf:cleanup-error:build");
    const { sandbox } = await session.attachment.ensureReady({ timeoutMs: 5_000 });
    vi.spyOn(sandbox, "rm").mockRejectedValueOnce(new Error("transport down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(cleanupAgentInputFiles(session, "/workspace", { runId: "cleanup-error" })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("cleanup failed"), expect.any(Error));
    } finally { warn.mockRestore(); }
  });

  it("sweeps old sibling runs in bounded rotating batches and retains fresh/current inputs", async () => {
    const h = await setup({ id: "build", type: "session", mode: "start", prompt: "Read" });
    await h.createRun("sweep-run");
    const session = await ensureWorkflowSession(h.opts, "wf:sweep-run:build");
    const { sandbox } = await session.attachment.ensureReady({ timeoutMs: 5_000 });
    const root = "/workspace/.valet/workflow-inputs";
    const now = Date.now();
    for (let i = 0; i < AGENT_INPUT_SWEEP_LIMIT + 20; i++) {
      await sandbox.mkdir(`${root}/old-${i}`);
      await sandbox.writeFile(`${root}/old-${i}/.created-at`, String(now - AGENT_INPUT_RETENTION_MS - 1));
    }
    await h.createRun("live-old");
    const settledAttempt = await h.createRun("settled-old");
    await h.workflowStore.beginTerminalize("settled-old", settledAttempt, "completed");
    await h.workflowStore.settleRun("settled-old", "completed");
    for (const run of ["current", "fresh", "live-old", "settled-old"]) {
      await sandbox.mkdir(`${root}/${run}`);
      await sandbox.writeFile(`${root}/${run}/.created-at`, String(run === "fresh" ? now : 1));
    }
    const rm = vi.spyOn(sandbox, "rm");
    await sweepAgentInputFiles(sandbox, "/workspace", "current", h.db, { orgId: LOCAL_ORG.id, ownerType: "user", ownerId: LOCAL_USER.id }, now);
    expect(rm.mock.calls.length).toBeLessThanOrEqual(AGENT_INPUT_SWEEP_LIMIT);
    expect((await sandbox.readdir(root)).filter(name => name.startsWith("old-"))).not.toHaveLength(0);
    await sweepAgentInputFiles(sandbox, "/workspace", "current", h.db, { orgId: LOCAL_ORG.id, ownerType: "user", ownerId: LOCAL_USER.id }, now);
    expect((await sandbox.readdir(root)).sort()).toEqual(["current", "fresh", "live-old"]);
    // Actual input delivery invokes the sweep as well.
    await writeAgentInputFiles(session, "/workspace", "Read", { dispatchId: "workflow:fresh:build", files: [{ path: "data.txt", content: "v1" }] }, h.db);
    await expect(sandbox.stat(`${root}/current`)).rejects.toThrow("ENOENT");
  });

  it("logs and counts run cleanup skipped after cache eviction", async () => {
    const h = await setup({ id: "build", type: "orchestrator", prompt: "Read", files: { "data.txt": "v1" } });
    const attempt = await h.createRun("uncached-run");
    const { session } = await ensureDefaultAssistantSession(h, { type: "user", id: LOCAL_USER.id }, { actorUserId: LOCAL_USER.id, orgId: LOCAL_ORG.id });
    await h.workflowStore.putIntent({ runId: "uncached-run", nodeId: "build", iteration: 0, status: "intent", attempt,
      createdAt: Date.now(), effects: { sessionId: session.id, inputFilesAttempted: true } });
    h.engineHost.evictCache(session.id);
    const skipped = vi.spyOn(inputMetrics, "recordWorkflowInputCleanupSkipped");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await cleanupWorkflowRunInputs(h.opts, "uncached-run");
      expect(skipped).toHaveBeenCalledWith("run", "uncached");
      expect(warn).toHaveBeenCalledWith("workflow input cleanup skipped", { sessionId: session.id, scope: "run", reason: "uncached" });
    } finally { skipped.mockRestore(); warn.mockRestore(); }
  });

  it.each(["owner", "org"])("sweeps a directory named for another %s's live run", async mismatch => {
    const h = await setup({ id: "build", type: "session", mode: "start", prompt: "Read" });
    await h.createRun("foreign-run");
    const session = await ensureWorkflowSession(h.opts, "wf:foreign-run:build");
    const { sandbox } = await session.attachment.ensureReady({ timeoutMs: 5_000 });
    const root = "/workspace/.valet/workflow-inputs/foreign-run";
    await sandbox.mkdir(root);
    await sandbox.writeFile(`${root}/.created-at`, "1");
    await sweepAgentInputFiles(sandbox, "/workspace", "current", h.db,
      { orgId: mismatch === "org" ? "other-org" : LOCAL_ORG.id, ownerType: "user",
        ownerId: mismatch === "owner" ? "other-user" : LOCAL_USER.id });
    await expect(sandbox.stat(root)).rejects.toThrow("ENOENT");
    expect((await h.workflowStore.getRun("foreign-run"))?.status).toBe("running");
  });

  it("does not remove a concurrent sibling node's marker staging file", async () => {
    const h = await setup({ id: "build", type: "session", mode: "start", prompt: "Read" });
    await h.createRun("marker-race");
    const session = await ensureWorkflowSession(h.opts, "wf:marker-race:build");
    const { sandbox } = await session.attachment.ensureReady({ timeoutMs: 5_000 });
    const original = sandbox.writeBinary.bind(sandbox);
    let staged = () => {};
    let release = () => {};
    const didStage = new Promise<void>(resolve => { staged = resolve; });
    const canRename = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(sandbox, "writeBinary").mockImplementation(async (path, bytes) => {
      await original(path, bytes);
      if (path.includes(".created-at.tmp-build.0.")) {
        staged();
        await canRename;
      }
    });
    const first = writeAgentInputFiles(session, "/workspace", "Read", {
      dispatchId: "workflow:marker-race:build", files: [{ path: "data.txt", content: "one" }],
    }, h.db);
    await didStage;
    try {
      await writeAgentInputFiles(session, "/workspace", "Read", {
        dispatchId: "workflow:marker-race:build-0", files: [{ path: "data.txt", content: "two" }],
      }, h.db);
    } finally { release(); }
    await first;
    expect(await sandbox.readFile(`${inputRoot("marker-race")}/data.txt`)).toBe("one");
    expect(await sandbox.readFile(`${inputRoot("marker-race", "build-0")}/data.txt`)).toBe("two");
  });

  it("removes crashed file and marker staging bytes before the next admission", async () => {
    const h = await setup({ id: "build", type: "session", mode: "start", prompt: "Read", files: { "nested/data.txt": "complete" } });
    const attempt = await h.createRun("stale-temp");
    const session = await ensureWorkflowSession(h.opts, "wf:stale-temp:build");
    const { sandbox } = await session.attachment.ensureReady({ timeoutMs: 5_000 });
    const directory = `${inputRoot("stale-temp")}/nested`;
    const markerRoot = "/workspace/.valet/workflow-inputs/stale-temp";
    const suffix = ".tmp-12345678-1234-1234-1234-123456789abc";
    await sandbox.mkdir(directory);
    await sandbox.writeFile(`${directory}/data.txt${suffix}`, "partial");
    await sandbox.writeFile(`${directory}/data.txt.tmp-crash`, "partial");
    await sandbox.writeFile(`${markerRoot}/.created-at${suffix}`, "1");
    await sandbox.writeFile(`${markerRoot}/.created-at.tmp-build.0.12345678-1234-1234-1234-123456789abc`, "1");
    faux?.setResponses([async () => {
      expect(await sandbox.readdir(directory)).toEqual(["data.txt"]);
      expect(await sandbox.readFile(`${directory}/data.txt`)).toBe("complete");
      expect((await sandbox.readdir(markerRoot)).some(name => name.includes(".tmp-"))).toBe(false);
      return fauxAssistantMessage("ok");
    }]);
    await h.drive("stale-temp", attempt);
    await vi.waitFor(async () => expect((await h.drive("stale-temp", attempt)).outcome).toBe("completed"), { timeout: 15_000 });
    expect(faux?.state.callCount).toBe(1);
  });

  it.each(["session", "orchestrator"] as const)("fails %s byte caps before provisioning or prompt admission", async (type) => {
    const provider = new VirtualSandboxProvider();
    const create = vi.spyOn(provider, "create");
    const node = type === "session"
      ? { id: "build", type, mode: "start" as const, prompt: "Read", files: { "too-large.txt": "é".repeat(MAX_AGENT_INPUT_FILE_BYTES / 2 + 1) } }
      : { id: "build", type, prompt: "Read", files: { "too-large.txt": "é".repeat(MAX_AGENT_INPUT_FILE_BYTES / 2 + 1) } };
    const h = await setup(node, undefined, provider);
    const attempt = await h.createRun("large-run");
    expect((await h.drive("large-run", attempt)).outcome).toBe("failed");
    const checkpoint = (await h.workflowStore.getCheckpoints("large-run")).find((cp) => cp.nodeId === "build");
    expect(checkpoint?.error).toContain('"too-large.txt" has 10485762 bytes, over the 10485760 byte cap');
    if (type === "session") expect(checkpoint?.effects?.sessionId).toBe("wf:large-run:build");
    expect(create).not.toHaveBeenCalled();
    expect(faux?.state.callCount).toBe(0);
  });

  it("strict foreach misses fail before the agent runs", async () => {
    const h = await setup({ id: "fan", type: "foreach", items: "{{trigger.data.rows}}", body: { id: "build", type: "session", mode: "start", prompt: "Read", files: { "missing.json": "{{item.missing}}" } } }, { onUnresolvedPath: "fail" });
    const attempt = await h.createRun("strict-run");
    expect((await h.drive("strict-run", attempt)).outcome).toBe("failed");
    expect(faux?.state.callCount).toBe(0);
  });

  it("rejects escaping literal keys and surfaces write failures before admission", async () => {
    const h = await setup({ id: "build", type: "session", mode: "start", prompt: "Read", files: { "safe.txt": "x" } });
    const attempt = await h.createRun("failure-run");
    const id = "wf:failure-run:build";
    await expect(h.engine.prompt(id, "Read", { dispatchId: "workflow:failure-run:build", files: [{ path: "../outside", content: "x" }] })).rejects.toThrow("files path");
    const session = await ensureWorkflowSession(h.opts, id);
    const { sandbox } = await session.attachment.ensureReady({ timeoutMs: 5_000 });
    vi.spyOn(sandbox, "writeBinary").mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    await expect(h.engine.prompt(id, "Read", { dispatchId: "workflow:failure-run:build", files: [{ path: "safe.txt", content: "x" }] })).rejects.toThrow("disk full");
    vi.spyOn(sandbox, "writeBinary").mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    expect((await h.drive("failure-run", attempt)).outcome).toBe("failed");
    const cp = (await h.workflowStore.getCheckpoints("failure-run")).find((row) => row.nodeId === "build");
    expect(cp?.error).toContain("disk full");
    await expect(sandbox.stat(inputRoot("failure-run"))).rejects.toThrow("ENOENT");
    expect(faux?.state.callCount).toBe(0);
    await expect(writeAgentInputFiles(session, "/workspace", "Read", { dispatchId: "workflow:../run:build", files: [{ path: "safe.txt", content: "x" }] }, h.db)).rejects.toThrow("dispatch ID is invalid");
  });
});
