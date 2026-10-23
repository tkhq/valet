import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import { Engine, InMemoryEventStream, InMemorySessionStore, readTurnCheckpoint, type ToolDef } from "../src/index.js";
import { HostDirSandbox, HostDirSandboxProvider } from "./fixtures/host-dir-sandbox.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

it.each(["other-path", "same-path", "preimage", "opaque"] as const)("does not undo unowned %s changes", async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), "valet-file-ownership-"));
  roots.push(root);
  const sandbox = new HostDirSandbox("setup", root);
  await writeFile(join(root, "a.txt"), "before");
  await writeFile(join(root, "b.txt"), "external before");
  const init = await sandbox.exec("git init -q && git config user.email t@example.test && git config user.name T && git add a.txt b.txt && git commit -qm init", { cwd: root });
  if (init.exitCode) throw new Error(init.stderr);
  const tool: ToolDef = {
    name: "change_file", description: "changes a file", sideEffect: "files", parameters: Type.Object({}),
    execute: async (_args, ctx) => {
      if (scenario === "preimage") await writeFile(join(root, "a.txt"), "external preimage");
      if (scenario === "opaque") await ctx.sandbox.exec("printf shell > a.txt", { cwd: root });
      else await ctx.sandbox.writeFile("a.txt", "assistant");
      if (scenario === "same-path") await writeFile(join(root, "a.txt"), "external after");
      if (scenario === "other-path") await writeFile(join(root, "b.txt"), "external after");
      return { text: "done" };
    },
  };
  const faux = registerFauxProvider({ provider: `file-ownership-${scenario}` });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("change_file", {}, { id: "write" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"), fauxAssistantMessage("replacement"),
  ]);
  const store = new InMemorySessionStore();
  const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new HostDirSandboxProvider(root) } });
  const session = await engine.createSession({ userId: "u1", orgId: "o1", workspace: root, sandbox: { workspace: root }, model: faux.getModel(), tools: [tool] });
  const thread = await session.ensureDefaultThread();
  const wait = async (id: string) => {
    const start = Date.now();
    while ((await store.getQueueItem(session.id, id))?.status !== "settled") {
      if (Date.now() - start > 10_000) throw new Error("Turn did not settle");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const first = await thread.submitPrompt("change", { author: { id: "u1" } });
  await wait(first.queueItemId);
  const entry = (await thread.readEntries()).find((item) => item.type === "message" && item.role === "user");
  if (!entry) throw new Error("Missing user entry");
  expect(readTurnCheckpoint(entry.metadata)?.repos[0]?.authoredPaths).toEqual(scenario === "other-path" ? ["a.txt"] : []);
  const edit = await thread.editMessage(entry.id, "replace", { author: { id: "u1" } }, { undoFiles: true });
  await wait(edit.queueItemId);
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe(
    scenario === "other-path" ? "before" : scenario === "same-path" ? "external after" : scenario === "opaque" ? "shell" : "assistant",
  );
  expect(await readFile(join(root, "b.txt"), "utf8")).toBe(scenario === "other-path" ? "external after" : "external before");
});
