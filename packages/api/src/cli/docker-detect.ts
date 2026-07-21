/**
 * Docker-daemon reachability probe for `valet serve`'s sandbox auto-detect
 * (spec decision 2). When the user makes no explicit backend choice, serve
 * defaults to `docker` IF a reachable daemon is detected, else `local`.
 *
 * The actual spawn is isolated behind an injectable `DockerProbe` seam so the
 * decision logic (`detectDockerDaemon`) is unit-testable without a real Docker
 * daemon.
 */
import { spawn } from "node:child_process";

/** Outcome of one `docker version` probe. */
export interface DockerProbeResult {
  /** Process exit code, or `null` if it never exited cleanly. */
  code: number | null;
  /** Captured stdout. */
  stdout: string;
  /** True if the probe was killed for exceeding the timeout. */
  timedOut: boolean;
  /** A spawn error (e.g. `ENOENT` when the `docker` binary is absent). */
  error?: Error;
}

/** A function that runs the docker probe once. Injected in tests. */
export type DockerProbe = () => Promise<DockerProbeResult>;

/** Default timeout for the probe. Docker's own CLI is snappy when the daemon
 * is up; a stuck/absent daemon shouldn't stall serve boot for long. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Spawn `docker version --format '{{.Server.Version}}'` and resolve with its
 * outcome. Never rejects — every failure mode (ENOENT, timeout, non-zero
 * exit) is reported through the resolved `DockerProbeResult`.
 */
export function spawnDockerProbe(timeoutMs = PROBE_TIMEOUT_MS): Promise<DockerProbeResult> {
  return new Promise<DockerProbeResult>((resolve) => {
    let stdout = "";
    let settled = false;
    const child = spawn("docker", ["version", "--format", "{{.Server.Version}}"], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ code: null, stdout, timedOut: true });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, timedOut: false, error });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, timedOut: false });
    });
  });
}

/**
 * True iff a reachable Docker daemon was detected: the probe exited 0 with a
 * non-empty server version. Any error/timeout/non-zero exit → false.
 */
export async function detectDockerDaemon(probe: DockerProbe = spawnDockerProbe): Promise<boolean> {
  try {
    const r = await probe();
    if (r.error || r.timedOut) return false;
    return r.code === 0 && r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}
