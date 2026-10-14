/**
 * Runs the real `valet` CLI as a child process with stdout connected to a
 * pipe. Node writes to a pipe asynchronously on POSIX, so a CLI that exits
 * before its queued writes finish cuts the output at the pipe buffer size
 * (64 KiB). A stub HTTP server answers the tool call, so no instance runs.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActionInvokeResponse } from "../wire/types.js";

const apiRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliEntry = join(apiRoot, "src", "cli.ts");
const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

const TOOL_ID = "greenhouse.list_applications";
// About 300 KB as JSON: more than four pipe buffers.
const response: ActionInvokeResponse = {
  tool_id: TOOL_ID,
  status: "completed",
  result: Array.from({ length: 2000 }, (_, i) => ({ id: i, status: "active", notes: "x".repeat(100) })),
};

interface CliResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

let server: Server;
let dataDir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === `/api/actions/${TOOL_ID}/invoke`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  dataDir = mkdtempSync(join(tmpdir(), "valet-cli-pipe-"));
  writeFileSync(
    join(dataDir, "config.json"),
    JSON.stringify({ defaultProfile: "stub", profiles: { stub: { url: `http://127.0.0.1:${port}`, apiKey: "test-key" } } }),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

/** Run `valet tools call` with stdout as a pipe. `closeEarly` closes the pipe after the first chunk. */
function callTool(closeEarly = false): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, VALET_DATA_DIR: dataDir };
    delete env.VALET_INSTANCE;
    const child = spawn(process.execPath, ["--import", tsxImport, cliEntry, "tools", "call", TOOL_ID, "--json"], {
      cwd: apiRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (closeEarly) child.stdout.destroy();
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(watchdog);
      resolve({ code, stdout: Buffer.concat(chunks), stderr });
    });
  });
}

describe("valet CLI output to a pipe", () => {
  it("writes a --json result larger than the pipe buffer completely", async () => {
    const { code, stdout, stderr } = await callTool();
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(4 * 65_536);
    expect(JSON.parse(stdout.toString("utf8"))).toEqual(response);
  }, 60_000);

  it("exits with the command's code when the reader closes the pipe early", async () => {
    const { code, stdout, stderr } = await callTool(true);
    expect(stdout.length).toBeLessThan(4 * 65_536);
    expect(stderr).toBe("");
    expect(code).toBe(0);
  }, 60_000);
});
