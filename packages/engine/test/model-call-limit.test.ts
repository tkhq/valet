import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import { fauxToolCall } from "../src/test-helpers/tool-intent.js";
import { MODEL_CALL_LIMIT_KEY } from "@valet/shared";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider, type ToolDef } from "../src/index.js";

/** Runs one submission whose model calls a tool `toolTurns` times, then answers. */
async function run(provider: string, toolTurns: number, metadata: Record<string, unknown>) {
  const faux = registerFauxProvider({ provider });
  try {
    let calls = 0;
    const tools: ToolDef[] = [{ name: "read_item", description: "Reads one item", parameters: Type.Object({}), execute: async () => { calls++; return { text: "ok" }; } }];
    const engine = new Engine({ providers: { store: new InMemorySessionStore(), stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
    const session = await engine.createSession({ userId: "alice", orgId: "org", owner: { type: "user", id: "alice" }, workspace: "/", sandbox: {}, purpose: "workflow", model: faux.getModel(), builtinTools: [], tools });
    faux.setResponses([
      ...Array.from({ length: toolTurns }, () => fauxAssistantMessage([fauxToolCall("read_item", {})], { stopReason: "toolUse" })),
      fauxAssistantMessage("all items read"),
    ]);
    const receipt = await session.prompt("read every item", { metadata });
    const outcome = await session.thread().awaitResult(receipt.queueItemId);
    return { outcome, calls, unused: faux.getPendingResponseCount() };
  } finally { faux.unregister(); }
}

describe("model call limit", () => {
  it("stops before the next model call at the limit and fails the submission with the fix", async () => {
    const { outcome, calls, unused } = await run("limit-hit", 5, { [MODEL_CALL_LIMIT_KEY]: 3 });
    expect(calls).toBe(3);
    expect(unused).toBe(3);
    expect(outcome).toMatchObject({ outcome: "failed" });
    expect(JSON.stringify(outcome)).toContain("This step stopped after 3 model calls, its limit");
    expect(JSON.stringify(outcome)).toContain("foreach");
  });

  it("completes when the last allowed call is the final answer", async () => {
    const { outcome, calls } = await run("limit-exact", 2, { [MODEL_CALL_LIMIT_KEY]: 3 });
    expect(calls).toBe(2);
    expect(outcome).toMatchObject({ outcome: "completed" });
  });

  it("does not limit a submission that sets no limit", async () => {
    const { outcome, calls } = await run("limit-none", 5, {});
    expect(calls).toBe(5);
    expect(outcome).toMatchObject({ outcome: "completed" });
  });
});
