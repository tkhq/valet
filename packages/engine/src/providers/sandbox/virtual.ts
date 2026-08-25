import type {
  ExecJobHandle,
  ExecOpts,
  ExecResult,
  JobPoll,
  Sandbox,
  SandboxCapabilities,
  SandboxCreateOpts,
  SandboxProvider,
  SandboxStatus,
} from "../../types.js";
import { CappedOutputBuffer } from "../../sandbox/output-buffer.js";

interface FsEntry {
  type: "file" | "dir";
  content?: Uint8Array;
}

function normalize(path: string): string {
  if (!path.startsWith("/")) path = "/" + path;
  const parts = path.split("/").filter((p) => p && p !== ".");
  const stack: string[] = [];
  for (const p of parts) {
    if (p === "..") stack.pop();
    else stack.push(p);
  }
  return "/" + stack.join("/");
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * In-memory sandbox for tests. Shell commands are intentionally minimal —
 * just enough to exercise the engine without containers:
 *   echo, cat, ls, pwd, true, false, sh -c "<above>"
 * Anything else returns exitCode 127.
 */
export class VirtualSandbox implements Sandbox {
  readonly id: string;
  private fs = new Map<string, FsEntry>();
  private cwd = "/";
  private jobs = new Map<string, JobPoll>();
  private nextJobId = 1;

  constructor(id: string) {
    this.id = id;
    this.fs.set("/", { type: "dir" });
  }

  private ensureParentDirs(path: string): void {
    const parts = path.split("/").filter(Boolean);
    let cur = "";
    for (let i = 0; i < parts.length - 1; i++) {
      cur += "/" + parts[i];
      if (!this.fs.has(cur)) this.fs.set(cur, { type: "dir" });
    }
  }

  async readFile(path: string): Promise<string> {
    return dec.decode(await this.readBinary(path));
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const e = this.fs.get(normalize(path));
    if (!e || e.type !== "file" || !e.content) throw new Error(`ENOENT: ${path}`);
    return e.content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    return this.writeBinary(path, enc.encode(content));
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const norm = normalize(path);
    this.ensureParentDirs(norm);
    this.fs.set(norm, { type: "file", content: data });
  }

  async readdir(path: string): Promise<string[]> {
    const norm = normalize(path);
    if (!this.fs.has(norm)) throw new Error(`ENOENT: ${path}`);
    const prefix = norm === "/" ? "/" : norm + "/";
    const names = new Set<string>();
    for (const k of this.fs.keys()) {
      if (k === norm) continue;
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const slash = rest.indexOf("/");
      names.add(slash === -1 ? rest : rest.slice(0, slash));
    }
    return [...names];
  }

  async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    const e = this.fs.get(normalize(path));
    // Carry `code` like node:fs does — callers distinguish not-found from
    // transport errors by it.
    if (!e) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return {
      isFile: e.type === "file",
      isDirectory: e.type === "dir",
      size: e.content?.length ?? 0,
    };
  }

  async mkdir(path: string): Promise<void> {
    const norm = normalize(path);
    this.ensureParentDirs(norm);
    if (!this.fs.has(norm)) this.fs.set(norm, { type: "dir" });
  }

  async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const norm = normalize(path);
    const e = this.fs.get(norm);
    if (!e) return;
    if (e.type === "dir" && opts?.recursive) {
      const prefix = norm === "/" ? "/" : norm + "/";
      for (const k of [...this.fs.keys()]) if (k.startsWith(prefix)) this.fs.delete(k);
    }
    this.fs.delete(norm);
  }

  async exec(command: string, opts?: ExecOpts): Promise<ExecResult> {
    const cwd = opts?.cwd ?? this.cwd;
    const out = await runVirtualCommand(this, command, cwd, opts?.env);
    if (opts?.maxOutputBytes && out.stdout.length > opts.maxOutputBytes) {
      // Same head+tail cap as the real sandboxes (see CappedOutputBuffer).
      const buf = new CappedOutputBuffer(opts.maxOutputBytes);
      buf.append(out.stdout);
      return { ...out, stdout: buf.value(), truncated: buf.truncated ? true : undefined };
    }
    return out;
  }

  async snapshot(): Promise<string> {
    return `${this.id}@${Date.now()}`;
  }

  async tunnels(): Promise<Record<string, string>> {
    return {};
  }

  async destroy(): Promise<void> {
    this.fs.clear();
  }

  /**
   * Trivial job mode for the virtual sandbox: there's no real async
   * detachment to model, so execJob just runs the command inline and
   * stores the completed result under a fresh execId. pollJob/cancelJob
   * operate on that stored terminal state.
   */
  async execJob(command: string, opts?: ExecOpts): Promise<ExecJobHandle> {
    const execId = `job-${this.nextJobId++}`;
    const result = await this.exec(command, opts);
    const output = result.stdout + result.stderr;
    this.jobs.set(execId, {
      status: "done",
      exitCode: result.exitCode,
      output,
      nextOffset: output.length,
      ...(result.truncated ? { truncated: true } : {}),
    });
    return { execId };
  }

  async pollJob(execId: string, offset: number): Promise<JobPoll> {
    const job = this.jobs.get(execId);
    if (!job) return { status: "failed", output: "", nextOffset: offset };
    return { ...job, output: job.output.slice(offset) };
  }

  async cancelJob(execId: string): Promise<void> {
    const job = this.jobs.get(execId);
    if (job) this.jobs.set(execId, { ...job, status: "failed" });
  }
}

async function runVirtualCommand(
  sb: VirtualSandbox,
  command: string,
  cwd: string,
  env?: Record<string, string>,
): Promise<ExecResult> {
  // Strip "sh -c '...'" wrapping
  const shMatch = command.match(/^\s*(?:bash|sh)\s+-c\s+(['"])([\s\S]*)\1\s*$/);
  const inner = shMatch ? shMatch[2] : command;
  const trimmed = inner.trim();

  if (trimmed === "true" || trimmed === ":") return ok("");
  if (trimmed === "false") return { stdout: "", stderr: "", exitCode: 1 };
  if (trimmed === "pwd") return ok(cwd + "\n");

  const echoMatch = trimmed.match(/^echo\s+(.*)$/);
  if (echoMatch) {
    let arg = echoMatch[1].replace(/^['"]|['"]$/g, "");
    // Minimal $VAR expansion against the per-request env — just enough to
    // exercise "env injected on this exec, gone on the next" in tests.
    const varMatch = arg.match(/^\$(\w+)$/);
    if (varMatch) arg = env?.[varMatch[1]] ?? "";
    return ok(arg + "\n");
  }

  const catMatch = trimmed.match(/^cat\s+(\S+)$/);
  if (catMatch) {
    try {
      const content = await sb.readFile(resolveRel(cwd, catMatch[1]));
      return ok(content);
    } catch (e) {
      return { stdout: "", stderr: `cat: ${(e as Error).message}\n`, exitCode: 1 };
    }
  }

  // mkdir [-p] <path> — create directory and any missing parents; always succeeds
  const mkdirMatch = trimmed.match(/^mkdir\s+(?:-p\s+)?(\S+)$/);
  if (mkdirMatch) {
    await sb.mkdir(resolveRel(cwd, mkdirMatch[1]));
    return ok("");
  }

  // printf '%s' '<content>' > <path>
  // Supports POSIX single-quote escape: \'\' inside the quoted string embeds a literal single quote.
  const printfMatch = trimmed.match(/^printf\s+'%s'\s+'([\s\S]*)'\s+>\s+(\S+)$/);
  if (printfMatch) {
    // Unescape POSIX \'\' → ' (end-quote + literal-quote + reopen-quote → single quote)
    const fileContent = printfMatch[1].replace(/\'\'/g, "\'");
    const target = resolveRel(cwd, printfMatch[2]);
    await sb.writeFile(target, fileContent);
    return ok("");
  }

  // Compound command: cmd1 && cmd2 — runs left, then right only on success
  const andMatch = trimmed.match(/^([\s\S]+?)\s*&&\s*([\s\S]+)$/);
  if (andMatch) {
    const left = await runVirtualCommand(sb, andMatch[1].trim(), cwd, env);
    if (left.exitCode !== 0) return left;
    const right = await runVirtualCommand(sb, andMatch[2].trim(), cwd, env);
    return {
      stdout: left.stdout + right.stdout,
      stderr: left.stderr + right.stderr,
      exitCode: right.exitCode,
    };
  }

  const lsMatch = trimmed.match(/^ls(?:\s+(\S+))?$/);
  if (lsMatch) {
    const target = lsMatch[1] ? resolveRel(cwd, lsMatch[1]) : cwd;
    try {
      const names = await sb.readdir(target);
      return ok(names.sort().join("\n") + (names.length ? "\n" : ""));
    } catch (e) {
      return { stdout: "", stderr: `ls: ${(e as Error).message}\n`, exitCode: 2 };
    }
  }

  return { stdout: "", stderr: `command not found: ${trimmed}\n`, exitCode: 127 };
}

function resolveRel(cwd: string, p: string): string {
  if (p.startsWith("/")) return p;
  return cwd === "/" ? "/" + p : cwd + "/" + p;
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

// ── Provider ──────────────────────────────────────────────────────

export class VirtualSandboxProvider implements SandboxProvider {
  readonly backend = "virtual";
  private sandboxes = new Map<string, VirtualSandbox>();
  private nextId = 1;

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: false,
      tunnels: false,
      warmPool: false,
      hibernation: false,
      customImage: false,
      coldStartEstimateMs: 0,
    };
  }

  async create(_opts: SandboxCreateOpts): Promise<Sandbox> {
    const id = `vsb-${this.nextId++}`;
    const sb = new VirtualSandbox(id);
    this.sandboxes.set(id, sb);
    return sb;
  }

  async restore(id: string): Promise<Sandbox> {
    const sb = this.sandboxes.get(id);
    if (!sb) throw new Error(`virtual sandbox not found: ${id}`);
    return sb;
  }

  async destroy(id: string): Promise<void> {
    const sb = this.sandboxes.get(id);
    if (sb) await sb.destroy?.();
    this.sandboxes.delete(id);
  }

  async status(id: string): Promise<SandboxStatus> {
    return this.sandboxes.has(id)
      ? { id, state: "ready", startedAt: Date.now() }
      : { id, state: "released" };
  }
}
