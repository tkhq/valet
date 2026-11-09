/**
 * Command runners for the gather stage. In the plugin the runner is the
 * reviewer child's sandbox (`PluginChildRequest.prepare`), so the scan reads
 * the checkout the child already has. In the eval and the CLI it is a local
 * shell over a checkout at the same commit. Both run the same commands.
 */
import { execFile, spawn } from "node:child_process";
import type { ChildCommandResult, ChildCommandRunner } from "@valet/engine";

export type RepoRunner = ChildCommandRunner;

const LOCAL_TIMEOUT_MS = 60_000;
const LOCAL_OUTPUT_BYTES = 4 * 1024 * 1024;

/** A runner over a local checkout, with the sandbox runner's time and output caps. */
export function localRunner(workspace: string): RepoRunner {
  return {
    run(command, opts) {
      const cap = opts?.maxOutputBytes ?? LOCAL_OUTPUT_BYTES;
      return new Promise<ChildCommandResult>((resolve, reject) => {
        const child = spawn("sh", ["-c", command], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
        const out: Buffer[] = [];
        let outBytes = 0;
        let truncated = false;
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts?.timeoutMs ?? LOCAL_TIMEOUT_MS);
        child.stdout.on("data", (d: Buffer) => {
          if (outBytes + d.length > cap) {
            truncated = true;
            out.push(d.subarray(0, Math.max(0, cap - outBytes)));
            outBytes = cap;
            child.kill("SIGKILL");
            return;
          }
          out.push(d);
          outBytes += d.length;
        });
        child.stderr.on("data", (d: Buffer) => {
          if (stderr.length < 64 * 1024) stderr += d.toString();
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ exitCode: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr, truncated, timedOut });
        });
        child.stdin.on("error", () => undefined);
        child.stdin.end(opts?.stdin ?? "");
      });
    },
  };
}

/** A file's text at `ref` in a local checkout, or undefined when it does not exist there. */
export async function gitFileAt(workspace: string, ref: string, path: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["show", `${ref}:${path}`], { cwd: workspace, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? undefined : stdout));
  });
}
