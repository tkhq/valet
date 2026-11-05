/**
 * A sandbox whose paths are this machine's paths and whose commands run in a
 * real shell. File checkpoint tests need real git, which the virtual sandbox
 * does not have. Give it a temporary directory as the working directory. Like
 * the docker sandbox, its file calls refuse a path outside the working
 * directory and resolve a relative path against it.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExecOpts, ExecResult, Sandbox, SandboxCapabilities, SandboxCreateOpts, SandboxProvider, SandboxStatus } from "../../src/index.js";

export class HostDirSandbox implements Sandbox {
  constructor(readonly id: string, private readonly cwd: string) {}

  private within(path: string): string {
    const full = resolve(this.cwd, path);
    if (full !== this.cwd && !full.startsWith(`${this.cwd}/`)) throw new Error(`File path is outside the working directory: ${path}`);
    return full;
  }

  readFile(path: string): Promise<string> {
    return readFile(this.within(path), "utf8");
  }
  async readBinary(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.within(path)));
  }
  async writeFile(path: string, content: string): Promise<void> {
    const full = this.within(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const full = this.within(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  }
  readdir(path: string): Promise<string[]> {
    return readdir(this.within(path));
  }
  async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    const info = await stat(this.within(path));
    return { isFile: info.isFile(), isDirectory: info.isDirectory(), size: info.size };
  }
  async mkdir(path: string): Promise<void> {
    await mkdir(this.within(path), { recursive: true });
  }
  async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await rm(this.within(path), { force: true, recursive: opts?.recursive ?? false });
  }
  exec(command: string, opts?: ExecOpts): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = spawn("sh", ["-c", command], { cwd: opts?.cwd ?? this.cwd, env: { ...process.env, ...opts?.env } });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = opts?.timeout ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeout) : undefined;
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      // A missing cwd fails the spawn itself; a real sandbox reports a failed command.
      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        resolve({ stdout, stderr: err.message, exitCode: 127 });
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 1, ...(timedOut ? { timedOut: true } : {}) });
      });
      if (opts?.stdin !== undefined) child.stdin.end(opts.stdin);
      else child.stdin.end();
    });
  }
}

/** Host-directory sandboxes under one root, for `Engine` sessions; each works in its session's working directory. */
export class HostDirSandboxProvider implements SandboxProvider {
  readonly backend = "host-dir";
  private readonly sandboxes = new Map<string, HostDirSandbox>();
  private next = 1;
  constructor(private readonly root: string) {}

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: false,
      tunnels: false,
      warmPool: false,
      hibernation: false,
      customImage: false,
      nestedKubernetes: false,
      coldStartEstimateMs: 0,
    };
  }
  async create(opts: SandboxCreateOpts): Promise<Sandbox> {
    const sandbox = new HostDirSandbox(`host-${this.next++}`, opts.workspace ?? this.root);
    this.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }
  async restore(id: string): Promise<Sandbox> {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox) throw new Error(`host sandbox not found: ${id}`);
    return sandbox;
  }
  async destroy(id: string): Promise<void> {
    this.sandboxes.delete(id);
  }
  async status(id: string): Promise<SandboxStatus> {
    return this.sandboxes.has(id) ? { id, state: "ready", startedAt: Date.now() } : { id, state: "released" };
  }
}
