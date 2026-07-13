/**
 * Child entrypoint for the kill-mid-gate recovery proof (kill-mid-gate.test.ts).
 *
 * Runs a real Engine over a SqliteSessionStore + SqliteEventStream on `dbPath`,
 * with a faux provider scripted to emit ONE `do_thing` tool call. The tool calls
 * `ctx.requestDecision` (approval, resumeKey "kg"), which opens a durable
 * decision gate and suspends the turn — the submission durably parks in
 * `blocked_on_decision_gate` with a persisted suspended-turn checkpoint and a
 * pending gate row.
 *
 * Once the store shows the gate `pending` AND the item `blocked_on_decision_gate`,
 * the child prints `READY:<gateId>` once, then hangs. The parent SIGKILLs it,
 * boots a fresh Engine over the same db (reconciliation re-arms the gate),
 * resolves the gate, and asserts the continuation replays to completion.
 *
 * The faux provider is registered here because pi-ai's provider registry is
 * per-process; the parent registers its own (same provider NAME so the persisted
 * model id resolves) scripted for the post-resolve continuation.
 *
 * argv: [dbPath]
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  Type,
} from "@mariozechner/pi-ai";
import {
  SqliteSessionStore,
  SqliteEventStream,
  applyEngineMigrations,
} from "@valet/store-sqlite";
import {
  Engine,
  VirtualSandboxProvider,
  type ToolDef,
} from "../src/index.js";

const [dbPath] = process.argv.slice(2);
if (!dbPath) {
  process.stderr.write("usage: kill-gate-child.ts <dbPath>\n");
  process.exit(2);
}

const approvalParams = Type.Object({ arg: Type.String() });
const approvalTool: ToolDef<typeof approvalParams> = {
  name: "do_thing",
  description: "approval-gated",
  parameters: approvalParams,
  execute: async (args, ctx) => {
    const r = await ctx.requestDecision({
      type: "approval",
      title: "ok?",
      resumeKey: "kg",
    });
    return { text: `did with ${r.actionId}` };
  },
};

const SESSION_ID = "kill-gate-sess";

async function main(): Promise<void> {
  const sqlite = new Database(dbPath);
  applyEngineMigrations(sqlite);
  const store = new SqliteSessionStore(drizzle(sqlite));
  const stream = new SqliteEventStream(sqlite);
  const engine = new Engine({
    providers: { store, stream, sandboxProvider: new VirtualSandboxProvider() },
  });

  // Same provider NAME as the parent so the persisted model id resolves in both
  // processes; the scripted responses differ (turn 1 here, continuation there).
  const faux = registerFauxProvider({ provider: "kill-mid-gate" });
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("do_thing", { arg: "x" }, { id: "tc1" })],
      { stopReason: "toolUse" },
    ),
  ]);

  const session = await engine.createSession({
    id: SESSION_ID,
    userId: "u1",
    orgId: "o1",
    workspace: "/",
    sandbox: {},
    model: faux.getModel(),
    tools: [approvalTool],
  });

  const receipt = await session.prompt("please do the thing");
  const itemId = receipt.queueItemId;

  // Wait until the gate row is durably pending AND the submission is durably
  // parked in blocked_on_decision_gate — the exact crash point the parent needs
  // reconciliation to re-arm.
  const start = Date.now();
  let gateId: string | undefined;
  while (Date.now() - start < 20_000) {
    const gates = await store.listDecisionGates(SESSION_ID);
    const pending = gates.find((g) => g.status === "pending");
    const item = await store.getQueueItem(SESSION_ID, itemId);
    if (pending && item?.status === "blocked_on_decision_gate") {
      gateId = pending.id;
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!gateId) {
    process.stderr.write("kill-gate-child: gate never reached pending+blocked\n");
    process.exit(1);
  }

  process.stdout.write(`READY:${gateId}\n`);

  // Stay alive until the parent SIGKILLs us. The suspended gate keeps the turn
  // parked; this interval guarantees the event loop never drains.
  setInterval(() => {}, 1000);
}

main().catch((err) => {
  process.stderr.write(`kill-gate-child fatal: ${String(err)}\n`);
  process.exit(1);
});
