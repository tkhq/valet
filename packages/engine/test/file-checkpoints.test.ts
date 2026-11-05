/**
 * File checkpoints (docs/specs/2026-10-22-thread-edit-fork-design.md, "File
 * checkpoints"): per-turn git snapshots in the sandbox, undone with an edit
 * and brought back with a return. Runs real git in a temporary directory.
 */
import { fauxToolCall } from "../src/test-helpers/tool-intent.js";
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import {
  Engine,
  FILE_CHECKPOINT_KEY,
  WORKSPACE_FILES,
  branchNoteText,
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

    const plan = planFileUndo([userEntry("e1", { [FILE_CHECKPOINT_KEY]: { repos: [{ repo: "app", before: before.commit, after: after.commit, changed, authoredPaths: changed }] } })]);
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
      userEntry("e1", { [FILE_CHECKPOINT_KEY]: { repos: [{ repo, before: "b1", after: "a1", changed: ["x"], authoredPaths: ["x"] }] } }),
      userEntry("e2"),
      userEntry("e3", { [FILE_CHECKPOINT_KEY]: { repos: [{ repo, before: "b3", after: "a3", changed: ["x", "y"], authoredPaths: ["x", "y"] }] } }),
    ]);
    expect(plan).toEqual([{ repo, paths: [{ path: "x", source: "b1", expected: "a3" }, { path: "y", source: "b3", expected: "a3" }] }]);
  });
});

describe("edit with file undo", () => {
  it.each(["app", WORKSPACE_FILES])("records, undoes and returns files in %s", async (repoName) => {
    const { root, repo: gitRepo, ws } = await workspace();
    const repo = repoName === WORKSPACE_FILES ? ws : gitRepo;
    if (repoName === WORKSPACE_FILES) await writeFile(join(repo, "a.txt"), "one\n");
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
    expect(readTurnCheckpoint(user?.metadata)?.repos.find((checkpoint) => checkpoint.repo === repoName)).toMatchObject({ repo: repoName, changed: ["a.txt", "b.txt"] });

    if (repoName === WORKSPACE_FILES) {
      const unchanged = readTurnCheckpoint(user?.metadata)?.repos.find((checkpoint) => checkpoint.repo === "app");
      expect(unchanged).toMatchObject({ repo: "app", changed: [] });
      expect(planForkSeed([user!]).some((seed) => seed.repo === "app" && seed.snapshot === unchanged?.after)).toBe(true);
    }
    const preview = await thread.previewEdit(user!.id, PERSON.id);
    expect(preview).toMatchObject({ turns: 1, pushed: false, files: [{ repo: repoName, path: "a.txt" }, { repo: repoName, path: "b.txt" }] });

    const edit = await thread.editMessage(user!.id, "change nothing", { author: PERSON }, { undoFiles: true });
    await waitFor(() => settled(edit.queueItemId));
    expect(await read(join(repo, "a.txt"))).toBe("one\n");
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
    const note = (await thread.readEntries()).find((e: SessionEntry): e is BranchSummaryEntry => e.type === "branch_summary");
    expect(readBranchNote(note?.metadata)?.files?.[0]).toMatchObject({ repo: repoName, restored: ["a.txt"], removed: ["b.txt"], skipped: [] });
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
      "cd ../.. && git clone -q remote.git ws2/app && git clone -q remote.git ws3/app",
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
      fauxAssistantMessage("continuing in the second-generation fork"),
      fauxAssistantMessage("edited copied message"),
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
    // Fork again AFTER the first fork note has its completed seedResult.
    await writeFile(join(targetRepo, "second-generation.txt"), "second fork only\n");
    const secondSnapshot = await snapshotRepo(target.sandbox, targetRepo, "refs/valet/second-generation");
    const secondPath = await fork.forkPath((await fork.readEntries()).at(-1)!.id);
    expect(secondPath.some((entry) => entry.type === "branch_summary" && readBranchNote(entry.metadata)?.seedResult)).toBe(true);
    const secondSeed = { ...planForkSeed(secondPath)[0]!, snapshot: secondSnapshot.commit };
    await blobs.put("fork-seed/test/second", await exportSeedBundle(target.sandbox, join(root, "ws2"), secondSeed));
    const secondTarget = await engine.createSession({ userId: "u1", orgId: "o1", workspace: join(root, "ws3"), sandbox: { workspace: join(root, "ws3") }, model: faux.getModel(), tools: [writeTool] });
    const secondFork = await secondTarget.createThread("web:second-fork");
    await secondFork.copyPath(secondPath, {
      source: { sessionId: target.id, threadId: fork.id }, actorId: PERSON.id,
      seed: { repos: [{ ...secondSeed, blobKey: "fork-seed/test/second" }] },
    });
    const secondPrompt = await secondFork.submitPrompt("continue second fork", { author: PERSON });
    await waitFor(() => settled(secondTarget.id, secondPrompt.queueItemId));
    const secondRepo = join(root, "ws3/app");
    expect(await read(join(secondRepo, "a.txt"))).toBe("two\n");
    expect(await read(join(secondRepo, "b.txt"))).toBe("new\n");
    expect(await read(join(secondRepo, "second-generation.txt"))).toBe("second fork only\n");
    const secondNotes = (await secondFork.readEntries()).filter((entry): entry is BranchSummaryEntry => entry.type === "branch_summary");
    expect(secondNotes).toHaveLength(2);
    expect(readBranchNote(secondNotes[0]!.metadata)?.seedResult).toEqual(readBranchNote(note?.metadata)?.seedResult);
    expect(readBranchNote(secondNotes[1]!.metadata)?.seedResult).toEqual([{ repo: "app", paths: expect.arrayContaining(["second-generation.txt"]) }]);
    // Original before/after commits must survive both bundle transfers.
    const copiedUser = (await secondFork.readEntries()).find((entry): entry is MessageEntry => entry.type === "message" && entry.role === "user" && entry.content === "change the files");
    const edited = await secondFork.editMessage(copiedUser!.id, "leave original files alone", { author: PERSON }, { undoFiles: true });
    await waitFor(() => settled(secondTarget.id, edited.queueItemId));
    expect(await read(join(secondRepo, "a.txt"))).toBe("one\n");
    expect(existsSync(join(secondRepo, "b.txt"))).toBe(false);
    expect(await read(join(secondRepo, "second-generation.txt"))).toBe("second fork only\n");
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

describe("non-repository workspace checkpoints", () => {
  const target = WORKSPACE_FILES;
  const snap = (sandbox: HostDirSandbox, ws: string, name: string) => snapshotRepo(sandbox, ws, `refs/valet/nonrepo/${name}`, true);

  it("undoes and returns loose files, preserving later edits, repositories and their indexes", async () => {
    const { sandbox, ws, repo } = await workspace();
    const index = await readFile(join(repo, ".git/index"));
    await writeFile(join(ws, "notes.txt"), "before");
    await writeFile(join(ws, "manual.txt"), "before");
    await writeFile(join(ws, ".env"), "secret");
    await mkdir(join(ws, "node_modules"));
    await writeFile(join(ws, "node_modules/dependency.txt"), "dependency");
    await sandbox.exec("git init --bare -q archive", { cwd: ws });
    const before = await snap(sandbox, ws, "before");
    await writeFile(join(ws, "notes.txt"), "after");
    await writeFile(join(ws, "manual.txt"), "after");
    await writeFile(join(ws, "new.txt"), "created");
    const after = await snap(sandbox, ws, "after");
    const changed = await changedPaths(sandbox, ws, before.commit, after.commit, true);
    expect(changed).toEqual(["manual.txt", "new.txt", "notes.txt"]);
    const files = await sandbox.exec(`git --git-dir=.valet-file-checkpoints ls-tree -r --name-only ${after.commit}`, { cwd: ws });
    expect(files.stdout.trim().split("\n")).toEqual(["manual.txt", "new.txt", "notes.txt"]);
    await writeFile(join(ws, "manual.txt"), "later manual edit");
    const entries = [userEntry("loose", { [FILE_CHECKPOINT_KEY]: { repos: [{ repo: target, before: before.commit, after: after.commit, changed, authoredPaths: changed }] } })];
    const [undo] = await restorePaths(sandbox, ws, planFileUndo(entries), () => "refs/valet/nonrepo/undo");
    expect(undo).toMatchObject({ restored: ["notes.txt"], removed: ["new.txt"], skipped: ["manual.txt"] });
    expect(await read(join(ws, "notes.txt"))).toBe("before");
    expect(await read(join(ws, "manual.txt"))).toBe("later manual edit");
    expect(existsSync(join(ws, "new.txt"))).toBe(false);
    const plan = returnPlan([], [{ ...undo!, bases: { "notes.txt": before.commit, "new.txt": before.commit } }]);
    await restorePaths(sandbox, ws, plan, () => "refs/valet/nonrepo/return");
    expect(await read(join(ws, "notes.txt"))).toBe("after");
    expect(await read(join(ws, "new.txt"))).toBe("created");
    expect(await readFile(join(repo, ".git/index"))).toEqual(index);
    expect(existsSync(join(ws, ".git"))).toBe(false);
  });

  it("protects newly initialized repositories and symlink ancestors during undo", async () => {
    const { sandbox, ws, root } = await workspace();
    await mkdir(join(ws, "plain"));
    await writeFile(join(ws, "plain/file.txt"), "before");
    await mkdir(join(ws, "made"));
    await writeFile(join(ws, "made/file.txt"), "before");
    const before = await snap(sandbox, ws, "before");
    await writeFile(join(ws, "made/file.txt"), "after");
    await writeFile(join(ws, "plain/file.txt"), "after");
    const after = await snap(sandbox, ws, "after");
    await sandbox.exec("git init -q made && git -C made add file.txt", { cwd: ws });
    const index = await readFile(join(ws, "made/.git/index"));
    const [result] = await restorePaths(sandbox, ws, [{ repo: target, paths: [{ path: "made/file.txt", source: before.commit, expected: after.commit }] }], () => "refs/valet/nonrepo/newrepo");
    expect(result).toMatchObject({ skipped: ["made/file.txt"] });
    expect(await read(join(ws, "made/file.txt"))).toBe("after");
    expect(await readFile(join(ws, "made/.git/index"))).toEqual(index);
    await sandbox.exec("mv made elsewhere && ln -s elsewhere made", { cwd: ws });
    const [linked] = await restorePaths(sandbox, ws, [{ repo: target, paths: [{ path: "made/file.txt", source: before.commit, expected: after.commit }] }], () => "refs/valet/nonrepo/link");
    expect(linked).toMatchObject({ skipped: ["made/file.txt"] });
    expect(await read(join(ws, "elsewhere/file.txt"))).toBe("after");
    // This target is not a repository. Only the symlink-ancestor guard can
    // prevent a write outside the working directory here.
    await sandbox.exec("mv workspace/plain outside && ln -s ../outside workspace/plain", { cwd: root });
    const [outside] = await restorePaths(sandbox, ws, [{ repo: target, paths: [{ path: "plain/file.txt", source: before.commit, expected: after.commit }] }], () => "refs/valet/nonrepo/outside");
    expect(outside).toMatchObject({ skipped: ["plain/file.txt"] });
    expect(await read(join(root, "outside/file.txt"))).toBe("after");
  });

  it("exports and applies a nonrepo fork seed without initializing the target workspace", async () => {
    const { sandbox, ws, root } = await workspace();
    await writeFile(join(ws, "notes.txt"), "fork content");
    const after = await snap(sandbox, ws, "fork");
    const seed = planForkSeed([userEntry("fork", { [FILE_CHECKPOINT_KEY]: { repos: [{ repo: target, before: after.commit, after: after.commit, changed: ["notes.txt"] }] } })])[0]!;
    const targetWs = join(root, "fork");
    await mkdir(targetWs);
    const fork = new HostDirSandbox("fork", targetWs);
    const bundle = await exportSeedBundle(sandbox, ws, seed);
    expect(await applySeedBundle(fork, targetWs, seed, bundle)).toEqual(["notes.txt"]);
    expect(await read(join(targetWs, "notes.txt"))).toBe("fork content");
    expect(existsSync(join(targetWs, ".git"))).toBe(false);
    await writeFile(join(targetWs, "notes.txt"), "manual target edit");
    await expect(applySeedBundle(fork, targetWs, seed, bundle)).rejects.toThrow("safely");
    expect(await read(join(targetWs, "notes.txt"))).toBe("manual target edit");
  });
});

describe("workspace coverage boundaries", () => {
  it("does not initialize an overlay inside a real root repository", async () => {
    const { sandbox, repo } = await workspace();
    const index = await readFile(join(repo, ".git/index"));
    const before = await snapshotRepo(sandbox, repo, "refs/valet/root/before");
    await expect(snapshotRepo(sandbox, repo, "refs/valet/root/overlay", true)).rejects.toThrow("snapshot");
    expect(existsSync(join(repo, ".valet-file-checkpoints"))).toBe(false);
    const after = await snapshotRepo(sandbox, repo, "refs/valet/root/after");
    expect(await changedPaths(sandbox, repo, before.commit, after.commit)).toEqual([]);
    expect(await readFile(join(repo, ".git/index"))).toEqual(index);
  });

  it("excludes existing overlay metadata after the working directory becomes a repository", async () => {
    const { sandbox, ws } = await workspace();
    await writeFile(join(ws, "notes.txt"), "loose file");
    await snapshotRepo(sandbox, ws, "refs/valet/conversion/overlay", true);
    await mkdir(join(ws, "nested/.valet-file-checkpoints"), { recursive: true });
    await writeFile(join(ws, "nested/.valet-file-checkpoints/data"), "internal");
    const initialized = await sandbox.exec("git init -q && git add .", { cwd: ws });
    expect(initialized.exitCode).toBe(0);
    const index = await readFile(join(ws, ".git/index"));
    const before = await snapshotRepo(sandbox, ws, "refs/valet/conversion/before");
    // Updating the object store must never appear as changes in the real repo.
    const overlay = await snapshotRepo(sandbox, ws, "refs/valet/conversion/empty", true);
    const overlayTree = await sandbox.exec(`git --git-dir=.valet-file-checkpoints ls-tree -r --name-only ${overlay.commit}`, { cwd: ws });
    expect(overlayTree.stdout).toBe("");
    const after = await snapshotRepo(sandbox, ws, "refs/valet/conversion/after");
    expect(await changedPaths(sandbox, ws, before.commit, after.commit)).toEqual([]);
    const tree = await sandbox.exec(`git ls-tree -r --name-only ${after.commit}`, { cwd: ws });
    expect(tree.stdout).toBe("app\nnotes.txt\n");
    expect(await readFile(join(ws, ".git/index"))).toEqual(index);
  });

  it("refuses oversized overlays and carries unavailable coverage into the file result", async () => {
    const { sandbox, ws } = await workspace();
    await writeFile(join(ws, "oversized.bin"), new Uint8Array(51 * 1024 * 1024));
    await expect(snapshotRepo(sandbox, ws, "refs/valet/large/before", true)).rejects.toThrow("snapshot");
    const plan = planFileUndo([userEntry("failed", { [FILE_CHECKPOINT_KEY]: { repos: [], unavailable: [{ repo: WORKSPACE_FILES, reason: "File size limit exceeded." }] } })]);
    const results = await restorePaths(sandbox, ws, plan, () => "refs/valet/large/restore");
    expect(results).toMatchObject([{ repo: WORKSPACE_FILES, restored: [], removed: [], failed: expect.stringContaining("coverage unavailable") }]);
    const text = branchNoteText({ kind: "edit", actions: [], moreActions: 0, filesChanged: true, grants: [], files: results });
    expect(text).toContain("Working directory");
    expect(text).toContain("coverage unavailable");
    expect(text).not.toContain(WORKSPACE_FILES);
  });

  it("uses the working-directory label in pending, successful and failed fork notes", () => {
    const base = { kind: "fork" as const, actions: [], moreActions: 0, filesChanged: false, grants: [] };
    for (const note of [
      { ...base, seed: [{ repo: WORKSPACE_FILES, snapshot: "abc", blobKey: "key" }] },
      { ...base, seedResult: [{ repo: WORKSPACE_FILES, paths: ["notes.txt"] }] },
      { ...base, seedResult: [{ repo: WORKSPACE_FILES, paths: [], failed: "A target file already exists." }] },
    ]) {
      expect(branchNoteText(note)).toContain("Working directory");
      expect(branchNoteText(note)).not.toContain(WORKSPACE_FILES);
    }
  });
});

describe("fork checkpoint completeness and isolation", () => {
  it.each(["app", WORKSPACE_FILES])("exports concurrent snapshots of %s without mixing their files", async (repo) => {
    const { sandbox, ws, root, repo: app } = await workspace();
    const workspaceFiles = repo === WORKSPACE_FILES;
    const dir = workspaceFiles ? ws : app;
    const name = workspaceFiles ? "notes.txt" : "a.txt";
    await writeFile(join(dir, name), "first snapshot");
    const first = await snapshotRepo(sandbox, dir, "refs/valet/concurrent/first", workspaceFiles);
    await writeFile(join(dir, name), "second snapshot");
    const second = await snapshotRepo(sandbox, dir, "refs/valet/concurrent/second", workspaceFiles);
    const seeds = [first, second].map((snapshot) => ({ repo, snapshot: snapshot.commit }));
    const bundles = await Promise.all(seeds.map((seed) => exportSeedBundle(sandbox, ws, seed)));
    for (const [index, seed] of seeds.entries()) {
      const forkWs = join(root, `concurrent-fork-${index}`);
      await mkdir(forkWs);
      const fork = new HostDirSandbox(`fork-${index}`, forkWs);
      await applySeedBundle(fork, forkWs, seed, bundles[index]!);
      expect(await read(join(workspaceFiles ? forkWs : join(forkWs, repo), name))).toBe(index === 0 ? "first snapshot" : "second snapshot");
    }
    const refs = await sandbox.exec(`${workspaceFiles ? "git --git-dir=.valet-file-checkpoints" : "git"} for-each-ref refs/valet/fork-exports`, { cwd: dir });
    expect(refs.stdout).toBe("");
  });

  it("does not export stale state after a coverage gap, and preserves the gap on return", async () => {
    const { sandbox, ws } = await workspace();
    const entries = [
      userEntry("known", { [FILE_CHECKPOINT_KEY]: { repos: [{ repo: WORKSPACE_FILES, before: "before", after: "stale", changed: [] }] } }),
      userEntry("gap", { [FILE_CHECKPOINT_KEY]: { repos: [], unavailable: [{ repo: WORKSPACE_FILES, reason: "Snapshot failed." }] } }),
    ];
    const seeds = planForkSeed(entries);
    expect(seeds).toMatchObject([{ repo: WORKSPACE_FILES, unavailable: "Snapshot failed." }]);
    await expect(exportSeedBundle(sandbox, ws, seeds[0]!)).rejects.toThrow("coverage unavailable for Working directory");
    const returning = returnPlan(planFileUndo(entries), [{ repo: WORKSPACE_FILES, restored: ["notes.txt"], removed: [], skipped: [], restorePoint: "point", bases: { "notes.txt": "base" } }]);
    expect(returning).toEqual([{ repo: WORKSPACE_FILES, paths: [], unavailable: "Snapshot failed." }]);
  });

  it("takes an empty eligible snapshot even when excluded dependencies exceed the size bound", async () => {
    const { sandbox, ws } = await workspace();
    await mkdir(join(ws, "node_modules"));
    await writeFile(join(ws, "node_modules/large.bin"), new Uint8Array(51 * 1024 * 1024));
    const snapshot = await snapshotRepo(sandbox, ws, "refs/valet/empty/before", true);
    expect(snapshot.empty).toBe(true);
  });
});

describe("checkpoint failure protection", () => {
  it.each([
    ["app", "source"], ["app", "expected"],
    [WORKSPACE_FILES, "source"], [WORKSPACE_FILES, "expected"],
  ])("preflights every commit before changing files in %s when %s is missing", async (repo, missing) => {
    const { sandbox, ws, repo: app } = await workspace();
    const dir = repo === WORKSPACE_FILES ? ws : app;
    await writeFile(join(dir, "a.txt"), "before");
    await writeFile(join(dir, "b.txt"), "before");
    const before = await snapshotRepo(sandbox, dir, "refs/valet/preflight/before", repo === WORKSPACE_FILES);
    await writeFile(join(dir, "a.txt"), "after");
    await writeFile(join(dir, "b.txt"), "after");
    const after = await snapshotRepo(sandbox, dir, "refs/valet/preflight/after", repo === WORKSPACE_FILES);
    const [result] = await restorePaths(sandbox, ws, [{ repo, paths: [
      { path: "a.txt", source: before.commit, expected: after.commit },
      { path: "b.txt", source: missing === "source" ? "0".repeat(40) : before.commit, expected: missing === "expected" ? "0".repeat(40) : after.commit },
    ] }], () => "refs/valet/preflight/restore");
    expect(result).toMatchObject({ restored: [], removed: [], failed: expect.stringContaining("commits are missing") });
    expect(await read(join(dir, "a.txt"))).toBe("after");
    expect(await read(join(dir, "b.txt"))).toBe("after");
  });

  it("uses the same exclusions for secret directory traversal and restore", async () => {
    const { sandbox, ws } = await workspace();
    await mkdir(join(ws, "prod-secrets"));
    await writeFile(join(ws, "prod-secrets/token.json"), "private");
    await mkdir(join(ws, "service-credentials"));
    await writeFile(join(ws, "service-credentials/token.json"), "private");
    const before = await snapshotRepo(sandbox, ws, "refs/valet/secrets/before", true);
    const tree = await sandbox.exec(`git --git-dir=.valet-file-checkpoints ls-tree -r --name-only ${before.commit}`, { cwd: ws });
    expect(tree.stdout).toBe("");
    const [result] = await restorePaths(sandbox, ws, [{ repo: WORKSPACE_FILES, paths: [{ path: "prod-secrets/token.json", source: before.commit, expected: before.commit }] }], () => "refs/valet/secrets/restore");
    expect(result).toMatchObject({ skipped: ["prod-secrets/token.json"], removed: [], restored: [] });
    expect(await read(join(ws, "prod-secrets/token.json"))).toBe("private");
  });
});

describe("fork snapshot history", () => {
  it.each(["app", WORKSPACE_FILES])("retains copied return-note objects but excludes abandoned refs in %s", async (repo) => {
    const { sandbox, ws, root, repo: app } = await workspace();
    const dir = repo === WORKSPACE_FILES ? ws : app;
    const snap = (label: string) => snapshotRepo(sandbox, dir, `refs/valet/history/${label}`, repo === WORKSPACE_FILES);
    await writeFile(join(dir, "a.txt"), "base");
    const before = await snap("before");
    await writeFile(join(dir, "a.txt"), "return point");
    const point = await snap("return-point");
    await writeFile(join(dir, "a.txt"), "current");
    const after = await snap("after");
    await writeFile(join(dir, "a.txt"), "abandoned");
    const abandoned = await snap("abandoned");
    const note: BranchSummaryEntry = {
      id: "return-note", sessionId: "s", threadId: "t", parentId: null, createdAt: 1,
      type: "branch_summary", branchRootId: "root", branchLeafId: "leaf", summary: "return point",
      metadata: { branchNote: { kind: "edit", actions: [], moreActions: 0, filesChanged: true, grants: [], files: [
        { repo, restored: ["a.txt"], removed: [], skipped: [], restorePoint: point.commit, bases: { "a.txt": before.commit } },
      ] } },
    };
    const seeds = planForkSeed([userEntry("current", { [FILE_CHECKPOINT_KEY]: { repos: [{ repo, before: after.commit, after: after.commit, changed: [] }] } }), note]);
    expect(seeds[0]!.history).toEqual(expect.arrayContaining([before.commit, point.commit, after.commit]));
    expect(seeds[0]!.history).not.toContain(abandoned.commit);
    const forkWs = join(root, "history-fork");
    await mkdir(forkWs);
    const fork = new HostDirSandbox("history-fork", forkWs);
    await applySeedBundle(fork, forkWs, seeds[0]!, await exportSeedBundle(sandbox, ws, seeds[0]!));
    const forkDir = repo === WORKSPACE_FILES ? forkWs : join(forkWs, repo);
    const git = repo === WORKSPACE_FILES ? "git --git-dir=.valet-file-checkpoints" : "git";
    expect((await fork.exec(`${git} cat-file -e ${abandoned.commit}`, { cwd: forkDir })).exitCode).not.toBe(0);
    const [restored] = await restorePaths(fork, forkWs, [{ repo, paths: [{ path: "a.txt", source: point.commit, expected: before.commit }] }], () => "refs/valet/history/restore");
    expect(restored).toMatchObject({ restored: ["a.txt"], removed: [] });
    expect(await read(join(forkDir, "a.txt"))).toBe("return point");
  });

  it.each([
    ["app", "source", "blob"], ["app", "expected", "blob"],
    ["app", "source", "tree"], ["app", "expected", "tree"],
    [WORKSPACE_FILES, "source", "blob"], [WORKSPACE_FILES, "expected", "blob"],
    [WORKSPACE_FILES, "source", "tree"], [WORKSPACE_FILES, "expected", "tree"],
  ])("refuses missing %s %s %s objects before writing any path", async (repo, side, kind) => {
    const { sandbox, ws, repo: app } = await workspace();
    const dir = repo === WORKSPACE_FILES ? ws : app;
    await writeFile(join(dir, "a.txt"), "before a");
    await writeFile(join(dir, "b.txt"), "unique before b");
    const before = await snapshotRepo(sandbox, dir, "refs/valet/corrupt/before", repo === WORKSPACE_FILES);
    await writeFile(join(dir, "a.txt"), "after a");
    await writeFile(join(dir, "b.txt"), "after b");
    const after = await snapshotRepo(sandbox, dir, "refs/valet/corrupt/after", repo === WORKSPACE_FILES);
    const git = repo === WORKSPACE_FILES ? "git --git-dir=.valet-file-checkpoints" : "git";
    await writeFile(join(dir, "b.txt"), "later b");
    const commit = side === "source" ? before.commit : after.commit;
    const object = (await sandbox.exec(`${git} rev-parse '${commit}${kind === "tree" ? "^{tree}" : ":b.txt"}'`, { cwd: dir })).stdout.trim();
    await rm(join(dir, repo === WORKSPACE_FILES ? ".valet-file-checkpoints" : ".git", "objects", object.slice(0, 2), object.slice(2)));
    const [result] = await restorePaths(sandbox, ws, [{ repo, paths: [
      { path: "a.txt", source: before.commit, expected: after.commit },
      { path: "b.txt", source: before.commit, expected: after.commit },
    ] }], () => "refs/valet/corrupt/restore");
    expect(result).toMatchObject({ restored: [], removed: [], failed: expect.stringContaining("are missing") });
    expect(await read(join(dir, "a.txt"))).toBe("after a");
    expect(await read(join(dir, "b.txt"))).toBe("later b");
  });
});

describe("repositories created during a turn", () => {
  it("captures the new repository for a fork and reports its unavailable undo baseline", async () => {
    const { root, ws } = await workspace();
    const createRepo: ToolDef = {
      name: "create_repo", description: "creates a repository", sideEffect: "files", parameters: Type.Object({}),
      execute: async (_args, ctx) => {
        const result = await ctx.sandbox.exec("mkdir made && git -C made init -q && printf 'new repository file' > made/notes.txt", { cwd: ws });
        if (result.exitCode !== 0) throw new Error(result.stderr);
        return { text: "created repository" };
      },
    };
    const faux = registerFauxProvider({ provider: "new-repo-checkpoint" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("create_repo", {}, { id: "create" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("created"), fauxAssistantMessage("edited without creating files"),
    ]);
    try {
      const store = new InMemorySessionStore();
      const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new HostDirSandboxProvider(root) } });
      const session = await engine.createSession({ userId: "u1", orgId: "o1", workspace: ws, sandbox: { workspace: ws }, model: faux.getModel(), tools: [createRepo] });
      const thread = await session.ensureDefaultThread();
      const wait = async (id: string) => {
        const start = Date.now();
        while ((await store.getQueueItem(session.id, id))?.status !== "settled") {
          if (Date.now() - start > 10_000) throw new Error("timeout");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      await wait((await thread.submitPrompt("make a repository", { author: PERSON })).queueItemId);
      const entries = await thread.readEntries();
      const user = entries.find((entry): entry is MessageEntry => entry.type === "message" && entry.role === "user")!;
      const checkpoint = readTurnCheckpoint(user.metadata)?.repos.find((repo) => repo.repo === "made");
      expect(checkpoint).toMatchObject({ repo: "made", changed: [], undoUnavailable: expect.stringContaining("created during the turn") });
      const seed = planForkSeed(entries).find((repo) => repo.repo === "made")!;
      expect(seed.unavailable).toBeUndefined();
      const targetWs = join(root, "new-repo-fork");
      await mkdir(targetWs);
      const target = new HostDirSandbox("new-repo-fork", targetWs);
      await applySeedBundle(target, targetWs, seed, await exportSeedBundle(session.sandbox, ws, seed));
      expect(await read(join(targetWs, "made/notes.txt"))).toBe("new repository file");
      await wait((await thread.editMessage(user.id, "do nothing", { author: PERSON }, { undoFiles: true })).queueItemId);
      expect(await read(join(ws, "made/notes.txt"))).toBe("new repository file");
      expect(existsSync(join(ws, "made/.git"))).toBe(true);
      const note = (await thread.readEntries()).find((entry) => entry.type === "branch_summary");
      expect(readBranchNote(note?.metadata)?.files).toEqual(expect.arrayContaining([expect.objectContaining({ repo: "made", failed: expect.stringContaining("created during the turn") })]));
    } finally {
      faux.unregister();
    }
  });
});

describe("checkpoint metadata Git exclusion", () => {
  it("keeps its self-ignored store out of later git init and git add -A", async () => {
    const { sandbox, ws } = await workspace();
    await writeFile(join(ws, "notes.txt"), "public");
    await snapshotRepo(sandbox, ws, "refs/valet/exclusion/before", true);
    // Upgrade a store created before self-ignore protection existed.
    await rm(join(ws, ".valet-file-checkpoints/.gitignore"));
    await snapshotRepo(sandbox, ws, "refs/valet/exclusion/upgraded", true);
    const initialized = await sandbox.exec("git init -q . && git add -A && git ls-files -z", { cwd: ws });
    expect(initialized.exitCode).toBe(0);
    expect(initialized.stdout.split("\0").filter(Boolean)).toEqual(["app", "notes.txt"]);
    expect(await read(join(ws, ".valet-file-checkpoints/.gitignore"))).toBe("*\n");
    const index = await readFile(join(ws, ".git/index"));
    await snapshotRepo(sandbox, ws, "refs/valet/exclusion/after", true);
    expect(await readFile(join(ws, ".git/index"))).toEqual(index);
    const ignored = await sandbox.exec("git check-ignore .valet-file-checkpoints/.gitignore .valet-file-checkpoints/HEAD", { cwd: ws });
    expect(ignored.exitCode).toBe(0);
    expect(ignored.stdout.trim().split("\n")).toEqual([".valet-file-checkpoints/.gitignore", ".valet-file-checkpoints/HEAD"]);
    // A directory must not turn atomic installation into a move inside it.
    await rm(join(ws, ".valet-file-checkpoints/.gitignore"));
    await mkdir(join(ws, ".valet-file-checkpoints/.gitignore"));
    await expect(snapshotRepo(sandbox, ws, "refs/valet/exclusion/invalid", true)).rejects.toThrow("snapshot");
    expect(await readFile(join(ws, ".git/index"))).toEqual(index);
  });
});
