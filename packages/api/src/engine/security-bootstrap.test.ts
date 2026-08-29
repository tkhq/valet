/**
 * Unit coverage for the Valet Security scanner bootstrap
 * (`security-bootstrap.ts`). Verifies the three best-effort PrepSteps, their
 * apply behavior against a fake sandbox, and best-effort failure swallowing.
 */
import { describe, it, expect } from "vitest";
import type { ExecOpts, ExecResult, Sandbox } from "@valet/engine";
import {
  securityToolPrepSteps,
  SEC_PREFLIGHT_SCRIPT,
  GITLEAKS_DOWNLOAD_URL,
  SEMGREP_INSTALL_COMMAND,
} from "./security-bootstrap.js";

// ── Fake sandbox ────────────────────────────────────────────────────────────
// A minimal real Sandbox: the bootstrap only calls mkdir/writeFile/exec. The
// other members are present to satisfy the interface but never called here.

interface ExecCall {
  command: string;
  opts?: ExecOpts;
}

class FakeSandbox implements Sandbox {
  readonly id = "fake";
  readonly writes: { path: string; content: string }[] = [];
  readonly mkdirs: string[] = [];
  readonly execs: ExecCall[] = [];
  constructor(private readonly execImpl?: (command: string) => Promise<ExecResult>) {}

  async readFile(): Promise<string> { return ""; }
  async readBinary(): Promise<Uint8Array> { return new Uint8Array(); }
  async writeFile(path: string, content: string): Promise<void> {
    this.writes.push({ path, content });
  }
  async writeBinary(): Promise<void> {}
  async readdir(): Promise<string[]> { return []; }
  async stat(): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    return { isFile: false, isDirectory: false, size: 0 };
  }
  async mkdir(path: string): Promise<void> { this.mkdirs.push(path); }
  async rm(): Promise<void> {}
  async exec(command: string, opts?: ExecOpts): Promise<ExecResult> {
    this.execs.push({ command, opts });
    if (this.execImpl) return this.execImpl(command);
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  async destroy(): Promise<void> {}
}

describe("securityToolPrepSteps", () => {
  it("returns exactly three best-effort steps with distinct stable ids", () => {
    const steps = securityToolPrepSteps();
    expect(steps.map((s) => s.id)).toEqual(["sec-preflight", "gitleaks", "semgrep"]);
    expect(steps.every((s) => s.critical === false)).toBe(true);

    // Distinct, non-empty ids and hashes.
    const ids = new Set(steps.map((s) => s.id));
    const hashes = new Set(steps.map((s) => s.hash));
    expect(ids.size).toBe(3);
    expect(hashes.size).toBe(3);
    expect(steps.every((s) => s.hash.length > 0)).toBe(true);

    // Hashes are stable across calls (content fingerprints, not random).
    const again = securityToolPrepSteps();
    expect(again.map((s) => s.hash)).toEqual(steps.map((s) => s.hash));
  });

  it("sec-preflight step stages the script then execs it into /usr/local/bin (privileged)", async () => {
    const sandbox = new FakeSandbox();
    const preflight = securityToolPrepSteps().find((s) => s.id === "sec-preflight");
    expect(preflight).toBeDefined();
    if (!preflight) throw new Error("missing sec-preflight step");

    await preflight.apply(sandbox);

    // Wrote the preflight script to a workspace-relative staging path.
    const staged = sandbox.writes.find((w) => w.content === SEC_PREFLIGHT_SCRIPT);
    expect(staged).toBeDefined();
    expect(staged?.path.startsWith("/")).toBe(false); // workspace-relative, not absolute

    // Then exec'd it into /usr/local/bin with chmod 755, privileged.
    const install = sandbox.execs.find((e) => e.command.includes("/usr/local/bin/sec-preflight"));
    expect(install).toBeDefined();
    expect(install?.command).toContain("chmod 755");
    expect(install?.opts?.privileged).toBe(true);
  });

  it("gitleaks step downloads the pinned release and installs it with an idempotence guard, privileged", async () => {
    const sandbox = new FakeSandbox();
    const gitleaks = securityToolPrepSteps().find((s) => s.id === "gitleaks");
    if (!gitleaks) throw new Error("missing gitleaks step");

    await gitleaks.apply(sandbox);

    const install = sandbox.execs.find((e) => e.command.includes(GITLEAKS_DOWNLOAD_URL));
    expect(install).toBeDefined();
    // Idempotence guard: skip when gitleaks already on PATH.
    expect(install?.command).toContain("command -v gitleaks");
    // Touches /usr/local/bin → privileged.
    expect(install?.command).toContain("/usr/local/bin/gitleaks");
    expect(install?.opts?.privileged).toBe(true);
    // Pinned URL uses the gitleaks_<ver>_linux_x64.tar.gz asset shape.
    expect(GITLEAKS_DOWNLOAD_URL).toMatch(/gitleaks_\d+\.\d+\.\d+_linux_x64\.tar\.gz$/);
  });

  it("semgrep step installs via pip with an idempotence guard, privileged (apt)", async () => {
    const sandbox = new FakeSandbox();
    const semgrep = securityToolPrepSteps().find((s) => s.id === "semgrep");
    if (!semgrep) throw new Error("missing semgrep step");

    await semgrep.apply(sandbox);

    const install = sandbox.execs.find((e) => e.command.includes(SEMGREP_INSTALL_COMMAND));
    expect(install).toBeDefined();
    expect(install?.command).toContain("command -v semgrep");
    // apt-get + pip need root → privileged.
    expect(install?.opts?.privileged).toBe(true);
    expect(SEMGREP_INSTALL_COMMAND).toContain("--break-system-packages");
  });

  it("each apply resolves (does not throw) when exec rejects — best-effort swallow", async () => {
    const rejectingSandbox = new FakeSandbox(async () => {
      throw new Error("network unreachable");
    });
    for (const step of securityToolPrepSteps()) {
      await expect(step.apply(rejectingSandbox)).resolves.toBeUndefined();
    }
  });

  it("each apply resolves when exec returns non-zero — best-effort swallow", async () => {
    const failingSandbox = new FakeSandbox(async () => ({
      stdout: "",
      stderr: "install failed",
      exitCode: 1,
    }));
    for (const step of securityToolPrepSteps()) {
      await expect(step.apply(failingSandbox)).resolves.toBeUndefined();
    }
  });
});
