/**
 * Unit coverage for `buildPrepSteps` — in particular the start-ref capture
 * logic that moved out of the old `buildWorkspacePrep` closure into the
 * position-0 clone step's `apply` (sandbox-reconciliation plan, Task 6).
 *
 * Uses the same recording-fake `Sandbox` pattern as `workspace-prep.test.ts`:
 * no engine, no docker, just direct function calls with scripted exec results.
 */
import { describe, it, expect, vi } from "vitest";
import type { ExecOpts, ExecResult, Sandbox, SessionStartRef } from "@valet/engine";
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
