/** Local disposable browser benchmark. VALET_BROWSER_BENCH_MODE=exec measures the old transport. */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DockerSandboxProvider } from "../packages/sandbox-docker/src/sandbox.js";
import { browserRequest, readBrowserExport } from "../packages/plugin-browser/src/client.js";
import type { Sandbox } from "@valet/engine";
import type { BrowserRequest } from "@valet/shared";

const root = await mkdtemp(join(process.cwd(), ".valet-browser-bench-"));
const mode = process.env.VALET_BROWSER_BENCH_MODE ?? "channel";
const provider = new DockerSandboxProvider({ inventoryRoot: join(root, "inventory"), browserEnabled: true });
let sandbox: Sandbox | undefined;
const identity = { protocolVersion: "1.0" as const, audience: "viewer" as const,
  sessionId: `latency-${Date.now()}`, threadId: "viewer", actorId: "local-user", ownerId: "local-user" };
const result: Record<string, unknown> = { mode, timestamp: new Date().toISOString() };
function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { samples: samples.length, medianMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)),
    p95Ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(2)),
    totalMs: Number(samples.reduce((a,b) => a+b, 0).toFixed(2)) };
}
try {
  await mkdir(join(root, "workspace"));
  sandbox = await provider.create({ workspace: join(root, "workspace"), image: process.env.VALET_BROWSER_TEST_IMAGE ?? "valet-sandbox-browser:local",
    sessionId: identity.sessionId, browser: { enabled: true } });
  const target = mode === "exec" ? new Proxy(sandbox, {
    get(object, name) {
      if (name === "openCommandChannel") return undefined;
      const value: unknown = Reflect.get(object, name);
      return typeof value === "function" ? value.bind(object) : value;
    },
  }) : sandbox;
  const send = (data: BrowserRequest) => browserRequest(target, data);
  await target.writeFile("latency-fixture.cjs", `require('node:http').createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<title>Latency fixture</title><input autofocus aria-label="Typing test" style="font-size:24px;width:1100px"><h1>Ready</h1><script>document.querySelector("input").addEventListener("input",e=>document.querySelector("h1").textContent=e.target.value)</script>')}).listen(5173,'0.0.0.0')`);
  const started = await target.exec("node latency-fixture.cjs > /tmp/latency-fixture.log 2>&1 &");
  if (started.exitCode !== 0) throw new Error("Fixture did not start");
  const control = await send({ ...identity, command: "control", action: "take" });
  const leaseId = control.status?.control?.id;
  if (!leaseId) throw new Error("No control lease");
  const created = await send({ ...identity, command: "tab", action: "new", leaseId, runtimeId: control.runtimeId, url: "http://localhost:5173" });
  const tab = created.status?.tabs.at(-1);
  if (!tab) throw new Error("No fixture tab");
  const input = { ...identity, command: "input" as const, leaseId, runtimeId: control.runtimeId, tabId: tab.id, documentId: tab.documentId };
  await send({ ...input, input: { type: "click", x: 120, y: 22 } });
  for (const kind of ["status", "key", "frame"] as const) {
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) {
      const begin = performance.now();
      if (kind === "status") await send({ ...identity, command: "status" });
      if (kind === "key") await send({ ...input, input: { type: "key", key: "a", phase: i % 2 ? "up" : "down" } });
      if (kind === "frame") {
        const frame = await send({ ...identity, command: "frame", runtimeId: control.runtimeId, tabId: tab.id, ...(mode === "exec" ? {} : { inline: true }) });
        if (mode === "exec") {
          if (!frame.artifact) throw new Error("Missing exported frame");
          await readBrowserExport(target, frame.artifact);
          await send({ ...identity, command: "ack", transferId: frame.artifact.transferId });
        } else if (!frame.frame) throw new Error("Missing inline frame");
      }
      samples.push(performance.now() - begin);
    }
    result[kind] = summary(samples);
  }
  await send({ ...identity, command: "control", action: "release", leaseId });
  console.log(JSON.stringify(result, null, 2));
  if (process.env.VALET_BROWSER_BENCH_OUTPUT) await writeFile(process.env.VALET_BROWSER_BENCH_OUTPUT, JSON.stringify(result, null, 2));
} finally {
  if (sandbox) await provider.destroy(sandbox.id);
  await rm(root, { recursive: true, force: true });
}
