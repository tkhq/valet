/**
 * File checkpoints (docs/specs/2026-10-22-thread-edit-fork-design.md, "File
 * checkpoints"): per-turn git snapshots in the sandbox, undone with an edit
 * and brought back with a return. Runs real git in a temporary directory.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import {
  Engine,
  FILE_CHECKPOINT_KEY,
  InMemoryBlobStore,
  applySeedBundle,
  exportSeedBundle,
  planForkSeed,
  InMemoryEventStream,
  InMemorySessionStore,
  changedPaths,
  findRepos,
  planFileUndo,
  readBranchNote,
  readTurnCheckpoint,
  restorePaths,
  returnPlan,
  snapshotRepo,
  type BranchSummaryEntry,
  type MessageEntry,
  type SessionEntry,
  type ToolDef,
} from "../src/index.js";
import { HostDirSandbox, HostDirSandboxProvider } from "./fixtures/host-dir-sandbox.js";

const PERSON = { id: "u1", name: "Owner", interactive: true };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "valet-checkpoints-"));
  roots.push(root);
  const repo = join(root, "workspace", "app");
  await mkdir(repo, { recursive: true });
  const sandbox = new HostDirSandbox("t", root);
  const init = await sandbox.exec(
    "git init -q && git config user.email t@example.test && git config user.name T && printf 'one\\n' > a.txt && printf 'keep\\n' > c.txt && git add . && git commit -qm init",
    { cwd: repo },
  );
  if (init.exitCode !== 0) throw new Error(init.stderr);
  return { root, repo, sandbox, ws: join(root, "workspace") };
}

const read = (path: string) => readFile(path, "utf8");

function userEntry(id: string, metadata?: Record<string, unknown>): MessageEntry {
  return { id, sessionId: "s", threadId: "t", parentId: null, type: "message", role: "user", content: id, metadata, createdAt: 1 };
}

describe("checkpoint scripts", () => {
  it("snapshots the whole working tree without touching the index", async () => {
    const { repo, sandbox, ws } = await workspace();
    expect(await findRepos(sandbox, ws)).toEqual(["app"]);
    const before = await snapshotRepo(sandbox, repo, "refs/valet/checkpoints/t/e/before");
    await writeFile(join(repo, "a.txt"), "two\n");
    await writeFile(join(repo, "b.txt"), "new\n");
    const after = await snapshotRepo(sandbox, repo, "refs/valet/checkpoints/t/e/after");

    expect(await changedPaths(sandbox, repo, before.commit, after.commit)).toEqual(["a.txt", "b.txt"]);
    expect((await sandbox.exec("git status --porcelain", { cwd: repo })).stdout).toBe(" M a.txt\n?? b.txt\n");
    expect((await sandbox.exec("git for-each-ref --format='%(refname)' refs/valet", { cwd: repo })).stdout.trim().split("\n"))
      .toEqual(["refs/valet/checkpoints/t/e/after", "refs/valet/checkpoints/t/e/before"]);
  });

  it("undoes only the turns' paths, skips a path changed after them, and a restore point brings them back", async () => {
    const { repo, sandbox, ws } = await workspace();
    const before = await snapshotRepo(sandbox, repo, "refs/valet/x/before");
    await writeFile(join(repo, "a.txt"), "two\n");
    await writeFile(join(repo, "b.txt"), "new\n");
    await writeFile(join(repo, "c.txt"), "turn\n");
    const after = await snapshotRepo(sandbox, repo, "refs/valet/x/after");
    const changed = await changedPaths(sandbox, repo, before.commit, after.commit);
    // Someone else changes c.txt after the turn.
    await writeFile(join(repo, "c.txt"), "someone else\n");
    // A file the turn never touched stays as it is.
    await writeFile(join(repo, "d.txt"), "other thread\n");

    const plan = planFileUndo([userEntry("e1", { [FILE_CHECKPOINT_KEY]: { repos: [{ repo: "app", before: before.commit, after: after.commit, changed }] } })]);
    const [result] = await restorePaths(sandbox, ws, plan, () => "refs/valet/x/restore");

    expect(result).toMatchObject({ restored: ["a.txt"], removed: ["b.txt"], skipped: ["c.txt"] });
    expect(await read(join(repo, "a.txt"))).toBe("one\n");
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
    expect(await read(join(repo, "c.txt"))).toBe("someone else\n");
    expect(await read(join(repo, "d.txt"))).toBe("other thread\n");
    expect((await sandbox.exec("git diff --cached --name-only", { cwd: repo })).stdout).toBe("");

    const bring = returnPlan([], [{ repo: "app", restored: ["a.txt"], removed: ["b.txt"], skipped: [], restorePoint: result!.restorePoint, bases: { "a.txt": before.commit, "b.txt": before.commit } }]);
    await restorePaths(sandbox, ws, bring, () => "refs/valet/x/restore-2");
    expect(await read(join(repo, "a.txt"))).toBe("two\n");
    expect(await read(join(repo, "b.txt"))).toBe("new\n");
  });

  it("records a same-size rewrite made in the same second as the last commit (racy git)", async () => {
    const { repo, sandbox } = await workspace();
    for (let round = 0; round < 3; round++) {
      await writeFile(join(repo, "a.txt"), `v${round}\n`.padEnd(4, "x"));
      const snap = await snapshotRepo(sandbox, repo, `refs/valet/racy/${round}`);
      expect((await sandbox.exec(`git show ${snap.commit}:a.txt`, { cwd: repo })).stdout).toBe(`v${round}\n`.padEnd(4, "x"));
    }
  });

  it("plans each path from the first turn that changed it to the last", () => {
    const repo = "/w/app";
    const plan = planFileUndo([
      userEntry("e1", { [FILE_CHECKPOINT_KEY]: { repos: [{ repo, before: "b1", after: "a1", changed: ["x"] }] } }),
      userEntry("e2"),
      userEntry("e3", { [FILE_CHECKPOINT_KEY]: { repos: [{ repo, before: "b3", after: "a3", changed: ["x", "y"] }] } }),
    ]);
    expect(plan).toEqual([{ repo, paths: [{ path: "x", source: "b1", expected: "a3" }, { path: "y", source: "b3", expected: "a3" }] }]);
  });
});

describe("edit with file undo", () => {
  it("records the turn's files, undoes them with the edit, and brings them back with a return", async () => {
    const { root, repo, ws } = await workspace();
    const writeTool: ToolDef = {
      name: "write_file",
      description: "writes a file",
      sideEffect: "files",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async (args, ctx) => {
        const { path, content } = args as { path: string; content: string };
        await ctx.sandbox.writeFile(path, content);
        return { text: "wrote" };
      },
    };
    const faux = registerFauxProvider({ provider: "checkpoint-edit" });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("write_file", { path: join(repo, "a.txt"), content: "two\n" }, { id: "w1" }),
        fauxToolCall("write_file", { path: join(repo, "b.txt"), content: "new\n" }, { id: "w2" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("changed"),
      fauxAssistantMessage("redone without files"),
    ]);
    const store = new InMemorySessionStore();
    const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new HostDirSandboxProvider(root) } });
    const session = await engine.createSession({ userId: "u1", orgId: "o1", workspace: ws, sandbox: { workspace: ws }, model: faux.getModel(), tools: [writeTool] });
    const thread = await session.ensureDefaultThread();
    const settled = async (id: string) => (await store.getQueueItem(session.id, id))?.status === "settled";
    const waitFor = async (check: () => Promise<boolean>) => {
      const start = Date.now();
      while (!(await check())) {
        if (Date.now() - start > 10_000) throw new Error("timeout");
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    const first = await thread.submitPrompt("change the files", { author: PERSON });
    await waitFor(() => settled(first.queueItemId));
    expect(await read(join(repo, "a.txt"))).toBe("two\n");
    const user = (await thread.readEntries()).find((e): e is MessageEntry => e.type === "message" && e.role === "user");
    expect(readTurnCheckpoint(user?.metadata)?.repos[0]).toMatchObject({ repo: "app", changed: ["a.txt", "b.txt"] });

    const preview = await thread.previewEdit(user!.id, PERSON.id);
    expect(preview).toMatchObject({ turns: 1, pushed: false, files: [{ repo: "app", path: "a.txt" }, { repo: "app", path: "b.txt" }] });

    const edit = await thread.editMessage(user!.id, "change nothing", { author: PERSON }, { undoFiles: true });
    await waitFor(() => settled(edit.queueItemId));
    expect(await read(join(repo, "a.txt"))).toBe("one\n");
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
    const note = (await thread.readEntries()).find((e: SessionEntry): e is BranchSummaryEntry => e.type === "branch_summary");
    expect(readBranchNote(note?.metadata)?.files?.[0]).toMatchObject({ repo: "app", restored: ["a.txt"], removed: ["b.txt"], skipped: [] });
    expect(note?.summary).toContain("File changes were undone to their state before the earlier version: a.txt, b.txt.");

    await thread.returnToBranch(note!.id, PERSON, { restoreFiles: true });
    expect(await read(join(repo, "a.txt"))).toBe("two\n");
    expect(await read(join(repo, "b.txt"))).toBe("new\n");
    faux.unregister();
  });
});

describe("fork with files", () => {
  it("carries the source thread's files at the fork point into a fork with its own working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "valet-fork-seed-"));
    roots.push(root);
    const host = new HostDirSandbox("setup", root);
    const setup = await host.exec([
      "git init -q --bare remote.git",
      "git clone -q remote.git ws1/app",
      "cd ws1/app && git config user.email t@example.test && git config user.name T && printf 'one\\n' > a.txt && git add a.txt && git commit -qm init && git push -q origin HEAD",
      "cd ../.. && git clone -q remote.git ws2/app",
    ].join(" && "));
    if (setup.exitCode !== 0) throw new Error(setup.stderr);
    const sourceRepo = join(root, "ws1", "app");
    const targetRepo = join(root, "ws2", "app");

    const writeTool: ToolDef = {
      name: "write_file",
      description: "writes a file",
      sideEffect: "files",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async (args, ctx) => {
        const { path, content } = args as { path: string; content: string };
        await ctx.sandbox.writeFile(path, content);
        return { text: "wrote" };
      },
    };
    const faux = registerFauxProvider({ provider: "fork-seed" });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("write_file", { path: join(sourceRepo, "a.txt"), content: "two\n" }, { id: "w1" }),
        fauxToolCall("write_file", { path: join(sourceRepo, "b.txt"), content: "new\n" }, { id: "w2" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("changed"),
      fauxAssistantMessage("continuing in the fork"),
    ]);
    const store = new InMemorySessionStore();
    const blobs = new InMemoryBlobStore();
    const engine = new Engine({ providers: { store, blobs, stream: new InMemoryEventStream(), sandboxProvider: new HostDirSandboxProvider(root) } });
    const source = await engine.createSession({ userId: "u1", orgId: "o1", workspace: join(root, "ws1"), sandbox: { workspace: join(root, "ws1") }, model: faux.getModel(), tools: [writeTool] });
    const target = await engine.createSession({ userId: "u1", orgId: "o1", workspace: join(root, "ws2"), sandbox: { workspace: join(root, "ws2") }, model: faux.getModel(), tools: [writeTool] });
    const sourceThread = await source.ensureDefaultThread();
    const settled = async (sessionId: string, id: string) => (await store.getQueueItem(sessionId, id))?.status === "settled";
    const waitFor = async (check: () => Promise<boolean>) => {
      const start = Date.now();
      while (!(await check())) {
        if (Date.now() - start > 10_000) throw new Error("timeout");
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const first = await sourceThread.submitPrompt("change the files", { author: PERSON });
    await waitFor(() => settled(source.id, first.queueItemId));

    const path = await sourceThread.forkPath((await sourceThread.readEntries()).at(-1)!.id);
    const seeds = planForkSeed(path);
    expect(seeds).toHaveLength(1);
    const bundle = await exportSeedBundle(source.sandbox, join(root, "ws1"), seeds[0]!);
    await blobs.put("fork-seed/test/0", bundle);
    const fork = await target.createThread("web:fork");
    await fork.copyPath(path, {
      source: { sessionId: source.id, threadId: sourceThread.id },
      actorId: PERSON.id,
      seed: { repos: [{ ...seeds[0]!, blobKey: "fork-seed/test/0" }] },
    });
    // The fork's first turn copies the files before its model call.
    const next = await fork.submitPrompt("keep going", { author: PERSON });
    await waitFor(() => settled(target.id, next.queueItemId));

    expect(await read(join(targetRepo, "a.txt"))).toBe("two\n");
    expect(await read(join(targetRepo, "b.txt"))).toBe("new\n");
    const note = (await fork.readEntries()).find((e: SessionEntry): e is BranchSummaryEntry => e.type === "branch_summary");
    expect(readBranchNote(note?.metadata)?.seedResult).toEqual([{ repo: "app", paths: expect.arrayContaining(["a.txt", "b.txt"]) }]);
    expect(note?.summary).toContain("were copied into");
    faux.unregister();
  });

  it("makes a repository the source thread created, and refuses one whose commits the fork lacks", async () => {
    const root = await mkdtemp(join(tmpdir(), "valet-fork-new-"));
    roots.push(root);
    const host = new HostDirSandbox("setup", root);
    const setup = await host.exec([
      "mkdir -p ws1/made ws2",
      "cd ws1/made && git init -q && git config user.email t@example.test && git config user.name T && printf 'base\\n' > plan.txt && git add plan.txt && git commit -qm init",
      "printf 'step two\\n' >> plan.txt && git commit -qam step2 && printf 'uncommitted\\n' >> plan.txt && printf 'draft\\n' > notes.md",
      "cd ../.. && git init -q --bare remote.git && git clone -q remote.git ws1/cloned",
      "cd ws1/cloned && git config user.email t@example.test && git config user.name T && printf 'one\\n' > a.txt && git add a.txt && git commit -qm init && git push -q origin HEAD && printf 'two\\n' > a.txt",
    ].join(" && "));
    if (setup.exitCode !== 0) throw new Error(setup.stderr);
    const source = new HostDirSandbox("source", join(root, "ws1"));
    const target = new HostDirSandbox("target", join(root, "ws2"));
    const seedOf = async (repo: string) => {
      const snap = await snapshotRepo(source, join(root, "ws1", repo), `refs/valet/checkpoints/t/e/${repo}`);
      return { repo, snapshot: snap.commit, ...(snap.branch ? { branch: snap.branch } : {}) };
    };

    // No remote: the bundle holds the whole history, so the fork makes the repository.
    const made = await seedOf("made");
    const paths = await applySeedBundle(target, join(root, "ws2"), made, await exportSeedBundle(source, join(root, "ws1"), made));
    expect(paths.sort()).toEqual(["notes.md", "plan.txt"]);
    expect(await read(join(root, "ws2", "made", "plan.txt"))).toBe("base\nstep two\nuncommitted\n");
    expect(await read(join(root, "ws2", "made", "notes.md"))).toBe("draft\n");
    const log = await target.exec("git log --format=%s && git status --short", { cwd: join(root, "ws2", "made") });
    expect(log.stdout).toBe("step2\ninit\n M plan.txt\n?? notes.md\n");

    // A remote: the bundle leaves out what the remote holds, which an empty repository lacks.
    const cloned = await seedOf("cloned");
    await expect(applySeedBundle(target, join(root, "ws2"), cloned, await exportSeedBundle(source, join(root, "ws1"), cloned)))
      .rejects.toThrow("no clone of cloned with the commits its changes build on");
    expect((await target.exec("ls -A cloned", { cwd: join(root, "ws2") })).stdout).toBe("");
    // Neither bundle file stays behind in a git directory.
    expect((await host.exec("find . -name 'valet-fork-seed-*'")).stdout).toBe("");
  });
});
