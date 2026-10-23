import { afterEach, describe, expect, it } from "vitest";
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applySeedBundle, changedPaths, exportSeedBundle, FILE_CHECKPOINT_KEY, planFileUndo, planForkSeed,
  readTurnCheckpoint, restorePaths, snapshotRepo, WORKSPACE_FILES,
  type BranchSummaryEntry, type MessageEntry, type SessionEntry } from "../src/index.js";
import { HostDirSandbox } from "./fixtures/host-dir-sandbox.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "valet-checkpoint-safety-"));
  roots.push(root);
  const ws = join(root, "ws");
  const repo = join(ws, "app");
  await mkdir(repo, { recursive: true });
  const sandbox = new HostDirSandbox("safety", root);
  const init = await sandbox.exec("git init -q && git config user.email t@example.test && git config user.name T && printf before > a.txt && git add . && git commit -qm init", { cwd: repo });
  if (init.exitCode) throw new Error(init.stderr);
  return { root, ws, repo, sandbox };
}
function user(repos: unknown[], id = "turn"): MessageEntry {
  return { id, sessionId: "s", threadId: "t", parentId: null, createdAt: 1, type: "message", role: "user", content: "turn",
    metadata: { [FILE_CHECKPOINT_KEY]: { repos } } };
}
function note(files: unknown[]): BranchSummaryEntry {
  return { id: "note", sessionId: "s", threadId: "t", parentId: null, createdAt: 2, type: "branch_summary",
    branchRootId: "root", branchLeafId: "leaf", summary: "undone",
    metadata: { branchNote: { kind: "edit", actions: [], moreActions: 0, filesChanged: true, grants: [], files } } };
}

describe("checkpoint safety review", () => {
  it("retains provenance and leaves concurrent and legacy whole-tree changes alone", async () => {
    const { ws, repo, sandbox } = await setup();
    const before = await snapshotRepo(sandbox, repo, "refs/valet/safety/before");
    await writeFile(join(repo, "a.txt"), "assistant");
    await writeFile(join(repo, "external.txt"), "external writer during the turn");
    const after = await snapshotRepo(sandbox, repo, "refs/valet/safety/after");
    const checkpoint = { repo: "app", before: before.commit, after: after.commit,
      changed: ["a.txt", "external.txt"], authoredPaths: ["a.txt"] };
    const entry = user([checkpoint]);
    expect(readTurnCheckpoint(entry.metadata)?.repos[0]).toMatchObject({ authoredPaths: ["a.txt"] });
    const [result] = await restorePaths(sandbox, ws, planFileUndo([entry]), () => "refs/valet/safety/recovery");
    expect(result).toMatchObject({ restored: ["a.txt"], removed: [], skipped: ["external.txt"] });
    expect(await readFile(join(repo, "external.txt"), "utf8")).toBe("external writer during the turn");
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("before");
    expect(planFileUndo([user([{ ...checkpoint, authoredPaths: undefined }])])).toEqual([
      { repo: "app", paths: [], skipped: ["a.txt", "external.txt"] },
    ]);
  });

  it("does not restore across an unattributed change to the same path", () => {
    const entries = [
      user([{ repo: "app", before: "b1", after: "a1", changed: ["a.txt"], authoredPaths: ["a.txt"] }]),
      user([{ repo: "app", before: "b2", after: "a2", changed: ["a.txt"] }], "other"),
    ];
    expect(planFileUndo(entries)).toEqual([{ repo: "app", paths: [], skipped: ["a.txt"] }]);
  });

  it.each(["before", "after"])("refuses a partial %s checkpoint for undo and forks", async (side) => {
    const { repo, sandbox } = await setup();
    await writeFile(join(repo, "preexisting.txt"), "preexisting untracked content");
    const exec = sandbox.exec.bind(sandbox);
    let limit = side === "before" ? "1" : "100";
    // Exercise real Git's partial snapshot path with a small byte budget.
    sandbox.exec = (command, options) => exec(command, { ...options,
      env: { ...options?.env, VALET_MAX_UNTRACKED_KB: limit } });
    const before = await snapshotRepo(sandbox, repo, "refs/valet/partial/before");
    limit = side === "after" ? "1" : "100";
    const after = await snapshotRepo(sandbox, repo, "refs/valet/partial/after");
    const changed = await changedPaths(sandbox, repo, before.commit, after.commit);
    // Identical live content appears created/deleted solely due to omission.
    expect(changed).toEqual(["preexisting.txt"]);
    expect(before.partial || after.partial).toBe(true);
    const entry = user([{ repo: "app", before: before.commit, after: after.commit, changed,
      authoredPaths: changed, partial: before.partial || after.partial }]);
    expect(planFileUndo([entry])).toMatchObject([{ repo: "app", paths: [], unavailable: expect.stringContaining("partial") }]);
    expect(planForkSeed([entry])).toMatchObject([{ repo: "app", unavailable: expect.stringContaining("partial") }]);
    expect(await readFile(join(repo, "preexisting.txt"), "utf8")).toBe("preexisting untracked content");
  });

  it("skips Git paths with symlink ancestors before reading or deleting external files", async () => {
    const { root, ws, repo, sandbox } = await setup();
    const before = await snapshotRepo(sandbox, repo, "refs/valet/ancestor/before");
    await mkdir(join(repo, "nested"));
    await writeFile(join(repo, "nested/new.txt"), "same bytes");
    const after = await snapshotRepo(sandbox, repo, "refs/valet/ancestor/after");
    const external = join(root, "external");
    await mkdir(external);
    await writeFile(join(external, "new.txt"), "same bytes");
    await rm(join(repo, "nested"), { recursive: true });
    await symlink(external, join(repo, "nested"));
    const [result] = await restorePaths(sandbox, ws, [{ repo: "app", paths: [
      { path: "nested/new.txt", source: before.commit, expected: after.commit },
    ] }], () => "refs/valet/ancestor/recovery");
    expect(result).toMatchObject({ skipped: ["nested/new.txt"], removed: [], restored: [] });
    expect(await readFile(join(external, "new.txt"), "utf8")).toBe("same bytes");
  });

  it("rejects a repository root replaced by a symlink before snapshotting or deleting external files", async () => {
    const { root, ws, repo, sandbox } = await setup();
    const before = await snapshotRepo(sandbox, repo, "refs/valet/root/before");
    await writeFile(join(repo, "created.txt"), "external file must survive");
    const after = await snapshotRepo(sandbox, repo, "refs/valet/root/after");
    const external = join(root, "external-copy");
    await cp(repo, external, { recursive: true });
    await rm(repo, { recursive: true });
    await symlink(external, repo);
    const [result] = await restorePaths(sandbox, ws, [{ repo: "app", paths: [
      { path: "created.txt", source: before.commit, expected: after.commit },
    ] }], () => "refs/valet/root/recovery");
    expect(result).toMatchObject({ restored: [], removed: [], failed: expect.stringContaining("repository path") });
    expect(await readFile(join(external, "created.txt"), "utf8")).toBe("external file must survive");
    expect((await sandbox.exec("git show-ref --verify refs/valet/root/recovery", { cwd: external })).exitCode).not.toBe(0);
  });

  it.each([1, 2])("pins the repository after guard %s even if its path is replaced before the next exec", async (swapAfter) => {
    const { root, ws, repo, sandbox } = await setup();
    const before = await snapshotRepo(sandbox, repo, "refs/valet/pinned/before");
    await writeFile(join(repo, "created.txt"), "external file must survive");
    const after = await snapshotRepo(sandbox, repo, "refs/valet/pinned/after");
    const external = join(root, "external-copy");
    await cp(repo, external, { recursive: true });
    const exec = sandbox.exec.bind(sandbox);
    let guards = 0;
    let swapped = false;
    sandbox.exec = async (command, options) => {
      const result = await exec(command, options);
      if (command.includes('safe_path "$VALET_REPO"') && ++guards === swapAfter) {
        await rename(repo, join(ws, "original-app"));
        await symlink(external, repo);
        swapped = true;
      }
      return result;
    };
    const [result] = await restorePaths(sandbox, ws, [{ repo: "app", paths: [
      { path: "created.txt", source: before.commit, expected: after.commit },
    ] }], () => "refs/valet/pinned/recovery");
    expect(swapped).toBe(true);
    expect(result).toMatchObject({ restored: [], removed: [], failed: expect.stringContaining("repository path") });
    expect(await readFile(join(external, "created.txt"), "utf8")).toBe("external file must survive");
    expect((await exec("git show-ref --verify refs/valet/pinned/recovery", { cwd: external })).exitCode).not.toBe(0);
  });

  it("does not follow a nested directory swapped for a symlink after the live hash read", async () => {
    const { root, ws, repo, sandbox } = await setup();
    const before = await snapshotRepo(sandbox, repo, "refs/valet/nested-race/before");
    await mkdir(join(repo, "nested"));
    await writeFile(join(repo, "nested/created.txt"), "same bytes");
    const after = await snapshotRepo(sandbox, repo, "refs/valet/nested-race/after");
    const external = join(root, "external");
    await mkdir(external);
    await writeFile(join(external, "created.txt"), "same bytes");
    const bin = join(root, "bin");
    await mkdir(bin);
    const exec = sandbox.exec.bind(sandbox);
    const git = (await exec("command -v git")).stdout.trim();
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    const marker = join(root, "swapped");
    await writeFile(join(bin, "git"), `#!/bin/sh
${quote(git)} "$@"
status=$?
if [ "$1" = hash-object ] && [ ! -e ${quote(marker)} ]; then
  mv ${quote(join(repo, "nested"))} ${quote(join(repo, "held"))}
  ln -s ${quote(external)} ${quote(join(repo, "nested"))}
  : > ${quote(marker)}
fi
exit "$status"
`);
    await chmod(join(bin, "git"), 0o755);
    sandbox.exec = (command, options) => exec(command, { ...options,
      env: { ...options?.env, PATH: `${bin}:${process.env.PATH}` } });
    await restorePaths(sandbox, ws, [{ repo: "app", paths: [
      { path: "nested/created.txt", source: before.commit, expected: after.commit },
    ] }], () => "refs/valet/nested-race/recovery");
    expect(await readFile(marker, "utf8")).toBe("");
    expect(await readFile(join(external, "created.txt"), "utf8")).toBe("same bytes");
  });

  it.each(["../app", "/absolute/app", "app/../app"])("rejects invalid saved repository path %s", async (target) => {
    const { ws, sandbox } = await setup();
    const [result] = await restorePaths(sandbox, ws, [{ repo: target, paths: [
      { path: "a.txt", source: "0".repeat(40), expected: "0".repeat(40) },
    ] }], () => "refs/valet/root/invalid");
    expect(result?.failed).toContain("repository path");
  });

  it("preserves a later executable-bit change even when the contents still match", async () => {
    const { ws, repo, sandbox } = await setup();
    const before = await snapshotRepo(sandbox, repo, "refs/valet/mode/before");
    await writeFile(join(repo, "a.txt"), "assistant");
    const after = await snapshotRepo(sandbox, repo, "refs/valet/mode/after");
    await chmod(join(repo, "a.txt"), 0o755);
    const [result] = await restorePaths(sandbox, ws, [{ repo: "app", paths: [
      { path: "a.txt", source: before.commit, expected: after.commit },
    ] }], () => "refs/valet/mode/recovery");
    expect(result).toMatchObject({ restored: [], removed: [], skipped: ["a.txt"] });
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("assistant");
    expect((await stat(join(repo, "a.txt"))).mode & 0o100).toBe(0o100);
  });

  it("prepares durable recovery only after successful preflight and before mutation", async () => {
    const { ws, repo, sandbox } = await setup();
    const before = await snapshotRepo(sandbox, repo, "refs/valet/prepared/before");
    await writeFile(join(repo, "a.txt"), "after");
    const after = await snapshotRepo(sandbox, repo, "refs/valet/prepared/after");
    let prepared = false;
    const [result] = await restorePaths(sandbox, ws, [{ repo: "app", paths: [{ path: "a.txt", source: before.commit, expected: after.commit }] }],
      () => "refs/valet/prepared/recovery", async (name, point) => {
        expect(name).toBe("app");
        expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("after");
        expect((await sandbox.exec(`git show ${point}:a.txt`, { cwd: repo })).stdout).toBe("after");
        prepared = true;
        throw new Error("journal CAS failed");
      });
    expect(prepared).toBe(true);
    expect(result).toMatchObject({ restored: [], removed: [], failed: "journal CAS failed" });
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("after");
    prepared = false;
    const [bad] = await restorePaths(sandbox, ws, [{ repo: "app", paths: [{ path: "a.txt", source: "0".repeat(40), expected: after.commit }] }],
      () => "refs/valet/prepared/invalid", async () => { prepared = true; });
    expect(prepared).toBe(false);
    expect(bad?.failed).toContain("missing");
  });

  it.each(["app", WORKSPACE_FILES])("forks the actual restored note state, including skipped files in %s", async (target) => {
    const { root, ws, repo, sandbox } = await setup();
    const overlay = target === WORKSPACE_FILES;
    const dir = overlay ? ws : repo;
    await writeFile(join(dir, "a.txt"), "before");
    const before = await snapshotRepo(sandbox, dir, "refs/valet/note/before", overlay);
    await writeFile(join(dir, "a.txt"), "assistant");
    await writeFile(join(dir, "skipped.txt"), "keep external");
    const after = await snapshotRepo(sandbox, dir, "refs/valet/note/after", overlay);
    const [restored] = await restorePaths(sandbox, ws, [{ repo: target, paths: [{ path: "a.txt", source: before.commit, expected: after.commit }] }], () => "refs/valet/note/recovery");
    const entries: SessionEntry[] = [user([{ repo: target, before: before.commit, after: after.commit, changed: ["a.txt"] }]),
      note([{ ...restored, bases: { "a.txt": before.commit } }])];
    const seed = planForkSeed(entries).find((item) => item.repo === target);
    if (!seed) throw new Error("Missing fork seed");
    const bundle = await exportSeedBundle(sandbox, ws, seed);
    const forkWs = join(root, "fork");
    await mkdir(forkWs);
    const fork = new HostDirSandbox("fork", forkWs);
    await applySeedBundle(fork, forkWs, seed, bundle);
    const forkDir = overlay ? forkWs : join(forkWs, target);
    expect(await readFile(join(forkDir, "a.txt"), "utf8")).toBe("before");
    expect(await readFile(join(forkDir, "skipped.txt"), "utf8")).toBe("keep external");
  });

  it("blocks an interrupted recovery journal rather than claiming its planned bases were restored", () => {
    const checkpoint = user([{ repo: "app", before: "before", after: "known", changed: ["a.txt"] }]);
    const journal = note([{ repo: "app", restored: [], removed: [], skipped: [], restorePoint: "point",
      bases: { "a.txt": "before" }, failed: "File restore interrupted. Return to recover files." }]);
    expect(planForkSeed([checkpoint, journal])).toMatchObject([{ repo: "app", unavailable: expect.stringContaining("interrupted") }]);
    const recovered = planForkSeed([checkpoint, journal, user([{ repo: "app", before: "new-before", after: "new-after", changed: [] }], "later")]);
    expect(recovered).toMatchObject([{ repo: "app", snapshot: "new-after" }]);
    expect(recovered[0]?.unavailable).toBeUndefined();
  });
});
