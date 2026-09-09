/**
 * Unit coverage for `buildPrepSteps` — in particular the start-ref capture
 * logic that moved out of the old `buildWorkspacePrep` closure into the
 * position-0 clone step's `apply` (sandbox-reconciliation plan, Task 6).
 *
 * Uses the same recording-fake `Sandbox` pattern as `workspace-prep.test.ts`:
 * no engine, no docker, just direct function calls with scripted exec results.
 */
import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxAttachment, SandboxPreparationError } from "@valet/engine";
import type { ExecOpts, ExecResult, Sandbox, SandboxProvider, SessionStartRef } from "@valet/engine";
import { buildPrepSteps } from "./prep-steps.js";
import { computeSpec } from "./sandbox-spec.js";
import type { ResolveSnapshot } from "./sandbox-spec.js";
import type { RepoBinding } from "../wire/types.js";

const API_URL = "https://api.valet.test";
const RESOLVE_CMD =
  "git remote get-url origin && git rev-parse HEAD && git rev-parse --abbrev-ref HEAD";
const SHA = "0123456789abcdef0123456789abcdef01234567";

interface ExecCall {
  command: string;
  opts?: ExecOpts;
}

/** Recording fake `Sandbox` — same pattern as workspace-prep.test.ts. */
class RecordingSandbox implements Sandbox {
  readonly id = "sb-test";
  execCalls: ExecCall[] = [];
  writes = new Map<string, string>();
  private gitDirs = new Set<string>();
  execResults = new Map<string, ExecResult>();

  markExistingClone(dir: string): void {
    this.gitDirs.add(dir);
  }

  setResult(command: string, result: ExecResult): void {
    this.execResults.set(command, result);
  }

  async readFile(): Promise<string> { throw new Error("not implemented"); }
  async readBinary(): Promise<Uint8Array> { throw new Error("not implemented"); }
  async writeFile(path: string, content: string): Promise<void> {
    this.writes.set(path, content);
  }
  async writeBinary(): Promise<void> { throw new Error("not implemented"); }
  async readdir(): Promise<string[]> { throw new Error("ENOENT"); }
  async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    if (path.endsWith("/.git") && this.gitDirs.has(path.slice(0, -"/.git".length))) {
      return { isFile: false, isDirectory: true, size: 0 };
    }
    throw new Error(`ENOENT: ${path}`);
  }
  async mkdir(): Promise<void> {}
  async rm(): Promise<void> {}
  async exec(command: string, opts?: ExecOpts): Promise<ExecResult> {
    this.execCalls.push({ command, opts });
    return this.execResults.get(command) ?? { stdout: "", stderr: "", exitCode: 0 };
  }
  async destroy(): Promise<void> {}
}

function makeSnap(repos: Array<RepoBinding & { targetDir: string }> = []): ResolveSnapshot {
  return {
    apiUrl: API_URL,
    stockImage: "stock:img",
    repoBake: null,
    baseBakeRef: null,
    repos,
    userName: "Ada Lovelace",
    userEmail: "ada@example.com",
  };
}

function makeBinding(overrides: Partial<RepoBinding & { targetDir: string }> = {}): RepoBinding & { targetDir: string } {
  return {
    host: "github",
    fullName: "acme/widgets",
    cloneUrl: "https://github.com/acme/widgets.git",
    auth: "auto",
    targetDir: ".",
    ...overrides,
  };
}

describe("buildPrepSteps — start-ref capture (position-0 clone step)", () => {
  it("a throwing onStartRef callback is contained: apply resolves, error logged, prep not failed", async () => {
    const snap = makeSnap([makeBinding()]);
    const { steps: specs } = computeSpec(snap);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const sandbox = new RecordingSandbox();
    // Provide a valid resolution so resolveStartRef succeeds.
    sandbox.setResult(RESOLVE_CMD, {
      stdout: `https://github.com/acme/widgets.git\n${SHA}\nmain\n`,
      stderr: "",
      exitCode: 0,
    });

    const throwingCallback = vi.fn((_ref: SessionStartRef) => {
      throw new Error("callback error");
    });

    const prepSteps = buildPrepSteps(snap, specs, throwingCallback);
    // Find and apply the clone step — it is the third spec (after credential-scripts, git-identity).
    const cloneStep = prepSteps.find((s) => s.id.startsWith("clone:"));
    expect(cloneStep).toBeDefined();

    // apply must resolve, not reject.
    await expect(cloneStep!.apply(sandbox)).resolves.toBeUndefined();

    // The callback was called (resolution succeeded), and its throw was caught.
    expect(throwingCallback).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("no onStartRef provided: resolve command never runs after clone", async () => {
    const snap = makeSnap([makeBinding()]);
    const { steps: specs } = computeSpec(snap);

    const sandbox = new RecordingSandbox();
    // No onStartRef → resolveStartRef must NOT be called.
    const prepSteps = buildPrepSteps(snap, specs /* no onStartRef */);
    const cloneStep = prepSteps.find((s) => s.id.startsWith("clone:"));
    expect(cloneStep).toBeDefined();

    await expect(cloneStep!.apply(sandbox)).resolves.toBeUndefined();

    // The resolution command must never have been issued.
    expect(sandbox.execCalls.some((c) => c.command.includes("git remote get-url origin"))).toBe(false);
  });

  it("resolveStartRef non-zero exit: logs, apply still resolves, onStartRef never called", async () => {
    const snap = makeSnap([makeBinding()]);
    const { steps: specs } = computeSpec(snap);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const sandbox = new RecordingSandbox();
    sandbox.setResult(RESOLVE_CMD, { stdout: "", stderr: "no origin", exitCode: 1 });

    const callback = vi.fn();
    const prepSteps = buildPrepSteps(snap, specs, callback);
    const cloneStep = prepSteps.find((s) => s.id.startsWith("clone:"));
    expect(cloneStep).toBeDefined();

    await expect(cloneStep!.apply(sandbox)).resolves.toBeUndefined();

    // Resolution returned null (non-zero exit) — callback must not be called.
    expect(callback).not.toHaveBeenCalled();
    // The failure is logged.
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("isPrimary gating: position-1 clone step never triggers start-ref resolution even with onStartRef", async () => {
    const primaryBinding = makeBinding({ fullName: "acme/widgets", targetDir: "widgets" });
    const secondaryBinding = makeBinding({
      fullName: "acme/gadgets",
      cloneUrl: "https://github.com/acme/gadgets.git",
      targetDir: "gadgets",
    });
    const snap = makeSnap([primaryBinding, secondaryBinding]);
    const { steps: specs } = computeSpec(snap);

    const sandbox = new RecordingSandbox();
    const callback = vi.fn();

    const prepSteps = buildPrepSteps(snap, specs, callback);

    // Apply ONLY the secondary (position-1) clone step.
    const secondaryStep = prepSteps.find((s) => s.id === "clone:acme/gadgets");
    expect(secondaryStep).toBeDefined();

    await expect(secondaryStep!.apply(sandbox)).resolves.toBeUndefined();

    // The resolution command must never have been issued for the secondary step.
    expect(sandbox.execCalls.some((c) => c.command.includes("git remote get-url origin"))).toBe(false);
    expect(callback).not.toHaveBeenCalled();
  });
});


describe("resume-safe preparation", () => {
  it("restores credential commands and identity without clone mutations", async () => {
    const snap = makeSnap([makeBinding({ ref: "main" })]);
    const sandbox = new RecordingSandbox();
    const steps = buildPrepSteps(snap, computeSpec(snap).steps);
    for (const step of steps) await step.afterResume?.(sandbox);
    expect(sandbox.execCalls.some(({ command }) => command.includes("/usr/local/bin/gh"))).toBe(true);
    expect(sandbox.execCalls.some(({ command }) => command.includes("credential.helper"))).toBe(true);
    expect(sandbox.execCalls.some(({ command }) => command.includes("user.name"))).toBe(true);
    expect(sandbox.execCalls.some(({ command }) => /git (clone|fetch|checkout|reset)/.test(command))).toBe(false);
  });

  it("preserves existing checkout when the container applied marker is missing", async () => {
    const snap = makeSnap([makeBinding({ ref: "main" })]);
    const sandbox = new RecordingSandbox();
    sandbox.markExistingClone(".");
    const steps = buildPrepSteps(snap, computeSpec(snap).steps);
    for (const step of steps) await step.apply(sandbox);
    expect(sandbox.execCalls.filter(({ command }) => /git (fetch|checkout|reset)/.test(command))).toEqual([]);
  });
});


it("restores managed Git settings idempotently while preserving user settings", async () => {
  const home = mkdtempSync(join(tmpdir(), "valet-resume-config-"));
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => execFileSync("git", args, { env, encoding: "utf8" }).trim();
  const sandbox = new RecordingSandbox();
  sandbox.exec = async (command) => {
    if (command.startsWith("git config ")) execFileSync("sh", ["-c", command], { env });
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  try {
    git("config", "--global", "alias.mine", "status --short");
    git("config", "--global", "--add", "safe.directory", "/user/repo");
    const snap = makeSnap();
    const steps = buildPrepSteps(snap, computeSpec(snap).steps);
    for (let wake = 0; wake < 2; wake++) {
      for (const step of steps) await step.afterResume?.(sandbox);
    }
    expect(git("config", "--global", "--get-all", "safe.directory").split("\n")).toEqual(["/user/repo", "*"]);
    expect(git("config", "--global", "alias.mine")).toBe("status --short");
    expect(git("config", "--global", "user.name")).toBe("Ada Lovelace");
    expect(git("config", "--global", "credential.helper")).toBe("/usr/local/bin/git-credential-valet");
  } finally { rmSync(home, { recursive: true, force: true }); }
});


it("keeps local commits, dirty files, and untracked files during missing-marker preparation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "valet-resume-repo-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    writeFileSync(join(dir, "tracked.txt"), "original");
    git("add", ".");
    git("commit", "-m", "base");
    git("checkout", "-b", "local-work");
    writeFileSync(join(dir, "local.txt"), "unpublished commit");
    git("add", ".");
    git("commit", "-m", "local work");
    writeFileSync(join(dir, "tracked.txt"), "dirty work");
    writeFileSync(join(dir, "untracked.txt"), "untracked work");
    const head = git("rev-parse", "HEAD");
    const status = git("status", "--porcelain");
    const sandbox = new RecordingSandbox();
    sandbox.stat = async (path) => {
      const st = statSync(join(dir, path));
      return { isFile: st.isFile(), isDirectory: st.isDirectory(), size: st.size };
    };
    sandbox.exec = async (command) => ({
      stdout: execFileSync("sh", ["-c", command], { cwd: dir, env, encoding: "utf8" }), stderr: "", exitCode: 0,
    });
    const snap = makeSnap([makeBinding({ ref: "main" })]);
    const step = buildPrepSteps(snap, computeSpec(snap).steps).find((step) => step.id.startsWith("clone:"));
    expect(step).toBeDefined();
    await step?.apply(sandbox);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("branch", "--show-current")).toBe("local-work");
    expect(git("status", "--porcelain")).toBe(status);
    expect(readFileSync(join(dir, "local.txt"), "utf8")).toBe("unpublished commit");
    expect(readFileSync(join(dir, "untracked.txt"), "utf8")).toBe("untracked work");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


it.each([
  { adopted: false, failingCommand: "mkdir -p /usr/local/bin" },
  { adopted: true, failingCommand: "mkdir -p /usr/local/bin" },
  { adopted: false, failingCommand: "git config --global user.name" },
  { adopted: true, failingCommand: "git config --global user.name" },
])("blocks readiness when $failingCommand fails (adopted: $adopted)", async ({ adopted, failingCommand }) => {
  const recording = new RecordingSandbox();
  const sandbox: Sandbox = Object.assign(recording, { adopted });
  recording.markExistingClone(".");
  recording.exec = async (command) => ({
    stdout: "", stderr: "container write failed", exitCode: command.startsWith("cat ") || command.includes(failingCommand) ? 1 : 0,
  });
  const destroy = vi.fn(async () => {});
  const release = vi.fn(async () => {});
  const provider: SandboxProvider = {
    backend: "test",
    capabilities: () => ({ snapshot: "none", persistentWorkspace: true, tunnels: false, warmPool: false, hibernation: true, customImage: false, coldStartEstimateMs: 0 }),
    create: async () => sandbox,
    restore: async () => sandbox,
    destroy, release,
    status: async () => ({ id: sandbox.id, state: "ready" }),
  };
  const snap = makeSnap([makeBinding()]);
  const steps = buildPrepSteps(snap, computeSpec(snap).steps);
  const att = new SandboxAttachment(provider, {}, async () => ({ specHash: "1", steps }));
  await expect(att.ensureReady({ timeoutMs: 1000 })).rejects.toBeInstanceOf(SandboxPreparationError);
  expect(att.current()).toBeNull();
  expect(att.state).toBe("error");
  if (adopted) {
    expect(release).toHaveBeenCalledWith(sandbox.id);
    expect(destroy).not.toHaveBeenCalled();
  }
});
