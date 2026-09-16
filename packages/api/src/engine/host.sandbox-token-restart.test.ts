import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = join(apiRoot, "test/sandbox-token-restart-child.ts");

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
    child.kill("SIGTERM");
  });
}

async function boot(dataDir: string) {
  const child = spawn(process.execPath, ["--import", "tsx", fixture, dataDir], {
    cwd: apiRoot,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, ANTHROPIC_API_KEY: "", VALET_LOCAL_AUTH: "0" },
  });
  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
  child.stdout?.resume();
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`API fixture startup timed out: ${stderr}`)), 30_000);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`API fixture exited (${code}): ${stderr}`));
      });
      child.once("message", (message: unknown) => {
        if (typeof message !== "object" || message === null || !("port" in message) || typeof message.port !== "number") {
          clearTimeout(timeout);
          reject(new Error("API fixture sent an invalid startup message."));
          return;
        }
        clearTimeout(timeout);
        resolve(message.port);
      });
    });
    return { child, baseUrl: `http://127.0.0.1:${port}` };
  } catch (error) {
    await stop(child);
    throw error;
  }
}

async function adopt(baseUrl: string) {
  const response = await fetch(`${baseUrl}/adopt`, { method: "POST", signal: AbortSignal.timeout(15_000) });
  expect(response.status).toBe(200);
  const result: unknown = await response.json();
  if (typeof result !== "object" || result === null || !("token" in result) || typeof result.token !== "string" || !("rows" in result) || !Array.isArray(result.rows)) {
    throw new Error("The fixture did not capture the sandbox token and database rows.");
  }
  return { token: result.token, rows: result.rows };
}

it("keeps a sandbox's original bearer valid across an API process restart and revokes it on destroy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "valet-sandbox-token-restart-"));
  const processes: ChildProcess[] = [];
  try {
    const first = await boot(join(dir, "pg"));
    processes.push(first.child);
    const provisioned = await adopt(first.baseUrl);
    expect(provisioned.rows).toHaveLength(1);
    // The parent retains the original environment bearer as a surviving sandbox would.
    const probe = (baseUrl: string) => fetch(`${baseUrl}/api/sandbox/probe`, {
      headers: { "x-valet-sandbox": provisioned.token }, signal: AbortSignal.timeout(10_000),
    });
    const before = await probe(first.baseUrl);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ sessionId: "sandbox-token-restart", userId: "restart-user", orgId: "restart-org" });
    await stop(first.child);
    expect(first.child.exitCode).toBe(0);

    const second = await boot(join(dir, "pg"));
    processes.push(second.child);
    expect(second.child.pid).not.toBe(first.child.pid);
    expect((await probe(second.baseUrl)).status).toBe(200);
    const adopted = await adopt(second.baseUrl);
    expect(adopted.token).toBe(provisioned.token);
    expect(adopted.rows).toEqual(provisioned.rows);
    expect((await probe(second.baseUrl)).status).toBe(200);

    const destroyed = await fetch(`${second.baseUrl}/destroy`, { method: "POST", signal: AbortSignal.timeout(10_000) });
    expect(destroyed.status).toBe(200);
    expect((await probe(second.baseUrl)).status).toBe(401);
  } finally {
    await Promise.all(processes.map(stop));
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
