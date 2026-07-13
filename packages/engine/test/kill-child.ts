/**
 * Child entrypoint for the kill-mid-turn recovery proof (kill-mid-turn.test.ts).
 *
 * Runs a real Engine over a SqliteSessionStore on `dbPath`, with a faux
 * provider scripted to emit TWO sequential `slow_marker` tool calls. The tool
 * appends `executed:<tag>` to `markerPath` and then sleeps 5s — long enough for
 * the parent test to SIGKILL this process while the FIRST tool call is still
 * sleeping. At that point the store durably holds an assistant entry with a
 * `tool_call` part stuck at status "running" (the crash point reconciliation
 * must repair to an error without re-executing).
 *
 * The faux provider is registered here because pi-ai's provider registry is
 * per-process; the parent registers its own (same provider NAME so the model id
 * resolves) scripted for the post-repair continuation.
 *
 * argv: [dbPath, markerPath]
 * Prints `READY:<queueItemId>` once, after submitPrompt, then never exits on its
 * own — the parent kills it.
 */
import { appendFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  Type,
} from "@mariozechner/pi-ai";
import { SqliteSessionStore, applyEngineMigrations } from "@valet/store-sqlite";
import {
  Engine,
  InMemoryEventStream,
  VirtualSandboxProvider,
  type ToolDef,
} from "../src/index.js";

const [dbPath, markerPath] = process.argv.slice(2);
if (!dbPath || !markerPath) {
  process.stderr.write("usage: kill-child.ts <dbPath> <markerPath>\n");
  process.exit(2);
}

async function main(): Promise<void> {
  const sqlite = new Database(dbPath);
  applyEngineMigrations(sqlite);
  const store = new SqliteSessionStore(drizzle(sqlite));
  const bus = new InMemoryEventStream();
  const engine = new Engine({
    providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() },
  });

  // Same provider NAME as the parent so the persisted model id resolves in both
  // processes; the scripted responses differ (turn 1 here, continuation there).
  const faux = registerFauxProvider({ provider: "kill-mid-turn" });
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("slow_marker", { tag: "call-1" }, { id: "call-1" })],
      { stopReason: "toolUse" },
    ),
    // Second sequential tool call — never reached; we are killed while call-1
    // sleeps. Present to prove reconciliation does not somehow drive it either.
    fauxAssistantMessage(
      [fauxToolCall("slow_marker", { tag: "call-2" }, { id: "call-2" })],
      { stopReason: "toolUse" },
    ),
  ]);

  const slowMarker: ToolDef<ReturnType<typeof Type.Object>> = {
    name: "slow_marker",
    description: "records a side effect then sleeps long enough to be killed",
    parameters: Type.Object({ tag: Type.String() }),
    execute: async (args) => {
      const tag = (args as { tag: string }).tag;
      // The one observable side effect. If reconciliation ever re-runs this
      // call, a second line appears and the parent's assertion fails.
      await appendFile(markerPath, `executed:${tag}\n`);
      // Sleep well past the kill window so the process dies mid-execution with
      // the tool_call part persisted as "running".
      await new Promise((r) => setTimeout(r, 5000));
      return { text: `done ${tag}` };
    },
  };

  const session = await engine.createSession({
    id: "kill-sess",
    userId: "u1",
    orgId: "o1",
    workspace: "/",
    sandbox: {},
    model: faux.getModel(),
    tools: [slowMarker],
  });

  const receipt = await session.prompt("do the slow thing");
  process.stdout.write(`READY:${receipt.queueItemId}\n`);

  // Stay alive until the parent SIGKILLs us. The tool's 5s sleep keeps the turn
  // in flight; this interval guarantees the event loop never drains even if
  // timing shifts.
  setInterval(() => {}, 1000);
}

main().catch((err) => {
  process.stderr.write(`kill-child fatal: ${String(err)}\n`);
  process.exit(1);
});
