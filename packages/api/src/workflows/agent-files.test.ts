import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualSandboxProvider } from "@valet/engine";
import { fauxAssistantMessage, registerFauxProvider } from "@valet/engine/test-helpers";
import { createDefaultNodeExecutors, driveUntilPark, MAX_AGENT_INPUT_FILE_BYTES, type WorkflowDefinition, type WorkflowNode, type RunHost } from "@valet/workflow";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { buildWorkflowEngineDeps, ensureWorkflowSession } from "./engine-deps.js";
import { writeAgentInputFiles } from "./agent-files.js";
import { resolveDefaultAssistant } from "../assistants/service.js";
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

async function setup(node: WorkflowNode, policy?: WorkflowDefinition["policy"], provider = new VirtualSandboxProvider()) {
  vi.stubEnv("ANTHROPIC_API_KEY", "faux-key");
  faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
  api = await bootTestApi({ workflowRunHost: inert, sandboxProvider: provider });
  const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
  const definition: WorkflowDefinition = { version: "dag/v1", nodes: [{ id: "t", type: "trigger" }, node], edges: [{ from: "t", to: node.id }], ...(policy ? { policy } : {}) };
  await db.insert(workflowDefinitions).values({ id: "files-wf", orgId: LOCAL_ORG.id, ownerType: "user", ownerId: LOCAL_USER.id, name: "Files", definition, createdAt: Date.now(), updatedAt: Date.now() });
  const opts = { host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials };
  const engine = buildWorkflowEngineDeps(opts);
  const createRun = async (id: string) => {
    await workflowStore.createRun(id, { workflowId: "files-wf", definitionVersionId: "v1", input: { type: "manual", timestamp: "now", data: { jobs: [{ id: 17, title: "héllo" }], rows: ["alpha", "beta"] }, metadata: {} } }, definition, "v1", { ownerType: "user", ownerId: LOCAL_USER.id });
    const claim = await workflowStore.claimRun(id, "files-test", 60_000);
    if (!claim) throw new Error("Could not claim test run");
    return claim.attempt;
  };
  const drive = (id: string, attempt: number) => driveUntilPark(id, attempt, { store: workflowStore, engine, clock: Date.now, executors: createDefaultNodeExecutors() });
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

  it("writes foreach session inputs into separate iteration directories with item/index values", async () => {
    const h = await setup({ id: "fan", type: "foreach", items: "{{trigger.data.rows}}", concurrency: 2, body: { id: "build", type: "session", mode: "start", prompt: "Read", wait: { mode: "none" }, files: { "item.txt": "{{item}}", "index.json": "{{index}}" } } });
    faux?.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
    const attempt = await h.createRun("foreach-run");
    expect((await h.drive("foreach-run", attempt)).outcome).toBe("completed");
    for (const [i, item] of ["alpha", "beta"].entries()) {
      const session = await ensureWorkflowSession(h.opts, `wf:foreach-run:build${i ? `:${i}` : ""}`);
      const sandbox = session.attachment.current();
      expect(await sandbox?.readFile(`${inputRoot("foreach-run", "build", i)}/item.txt`)).toBe(item);
      expect(await sandbox?.readFile(`${inputRoot("foreach-run", "build", i)}/index.json`)).toBe(String(i));
    }
  });

  it("scopes two orchestrator runs in the shared assistant sandbox without collisions", async () => {
    const h = await setup({ id: "build", type: "orchestrator", prompt: "Read", wait: { mode: "none" }, files: { "jobs.json": "{{trigger.data.jobs}}" } });
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
      expect((await h.drive(runId, attempt)).outcome).toBe("completed");
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

  it("re-dispatch rewrites identical inputs and returns the original receipt without another turn", async () => {
    const h = await setup({ id: "build", type: "session", mode: "start", prompt: "Read" });
    await h.createRun("retry-run");
    faux?.setResponses([fauxAssistantMessage("ok")]);
    const opts = { dispatchId: "workflow:retry-run:build", files: [{ path: "data.txt", content: "exact\n" }] };
    const id = "wf:retry-run:build";
    const first = await h.engine.prompt(id, "Read", opts);
    await vi.waitFor(async () => expect(await h.engine.isSettled(id, first.queueItemId)).toBe(true), { timeout: 15_000 });
    const sandbox = h.engineHost.liveSession(id)?.attachment.current();
    await sandbox?.writeFile(`${inputRoot("retry-run")}/data.txt`, "changed");
    // Simulates the crash window after admission but before receipt persistence.
    const second = await h.engine.prompt(id, "Read", opts);
    expect(second).toEqual(first);
    expect(await sandbox?.readFile(`${inputRoot("retry-run")}/data.txt`)).toBe("exact\n");
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
    vi.spyOn(sandbox, "writeBinary").mockRejectedValueOnce(new Error("disk full"));
    await expect(h.engine.prompt(id, "Read", { dispatchId: "workflow:failure-run:build", files: [{ path: "safe.txt", content: "x" }] })).rejects.toThrow("disk full");
    vi.spyOn(sandbox, "writeBinary").mockRejectedValueOnce(new Error("disk full"));
    expect((await h.drive("failure-run", attempt)).outcome).toBe("failed");
    const cp = (await h.workflowStore.getCheckpoints("failure-run")).find((row) => row.nodeId === "build");
    expect(cp?.error).toContain("disk full");
    expect(faux?.state.callCount).toBe(0);
    await expect(writeAgentInputFiles(session, "/workspace", "Read", { dispatchId: "workflow:../run:build", files: [{ path: "safe.txt", content: "x" }] })).rejects.toThrow("dispatch ID is invalid");
  });
});
