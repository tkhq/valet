import { fauxToolCall } from "../src/test-helpers/tool-intent.js";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, type Context } from "@earendil-works/pi-ai/compat";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import {
  builtinTools,
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  readThreadPlan,
  THREAD_PLAN_KEY,
  updatePlanTool,
  VirtualSandboxProvider,
  type CreateSessionOptions,
  type Session,
  type ThreadPlanItem,
} from "../src/index.js";
import { COMPLETE_SUMMARY } from "./fixtures/compaction-summary.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const ITEMS: ThreadPlanItem[] = [
  { text: "Read the failing test", status: "done" },
  { text: "Fix the parser", status: "in_progress" },
  { text: "Run the suite", status: "pending" },
];
const OVERLAY = "## Your current plan\n\n[x] Read the failing test\n[>] Fix the parser\n[ ] Run the suite\n\nKeep it current with update_plan.";

function setup(provider: string) {
  const faux = registerFauxProvider({ provider });
  cleanups.push(() => faux.unregister());
  const providers = { store: new InMemorySessionStore(), stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() };
  const options: CreateSessionOptions = {
    userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel(), compaction: { tailTurns: 1, autoContinue: false },
  };
  return { faux, providers, options };
}

/** A model step that records the system prompt and transcript it was sent. */
function capture(seen: { prompt: string; messages: string }[], text: string) {
  return (context: Context) => {
    seen.push({ prompt: getCurrentSystemPrompt(context.messages), messages: JSON.stringify(context.messages.filter((m) => m.role !== "system")) });
    return fauxAssistantMessage(text);
  };
}

function planCall(id: string, items: unknown) {
  return fauxAssistantMessage([fauxToolCall("update_plan", { items }, { id })], { stopReason: "toolUse" });
}

async function turn(session: Session, text: string): Promise<void> {
  const receipt = await session.prompt(text);
  expect((await session.thread().awaitResult(receipt.queueItemId)).outcome).toBe("completed");
}

async function toolResult(providers: ReturnType<typeof setup>["providers"], session: Session, callId: string) {
  for (const entry of await providers.store.getEntries(session.id, session.thread().id)) {
    if (entry.type !== "message") continue;
    const part = entry.parts?.find((p) => p.type === "tool_call" && p.callId === callId);
    if (part?.type !== "tool_call") continue;
    const { result } = part;
    return { status: part.status, text: typeof result === "object" && result !== null && "text" in result ? result.text : part.error };
  }
  throw new Error(`No tool call ${callId}`);
}

describe("update_plan", () => {
  it("is a builtin tool that every session and turn author gets", () => {
    expect(builtinTools.find((tool) => tool.name === "update_plan")).toBe(updatePlanTool);
    expect(updatePlanTool.ownerOnly).toBeUndefined();
  });

  it.each(["external", "guest"])("keeps %s input out of persistent plan context", async kind => {
    const { faux, providers, options } = setup(`plan-untrusted-${kind}`);
    const seen: { prompt: string; messages: string }[] = [];
    faux.setResponses([planCall("untrusted-plan", ITEMS), fauxAssistantMessage("Noted."), capture(seen, "Hello.")]);
    const session = await new Engine({ providers }).createSession(options);
    const receipt = await session.prompt("Remember this plan", { author: { id: kind === "guest" ? "another-member" : "u", externalSender: kind === "external" } });
    await session.thread().awaitResult(receipt.queueItemId);
    expect((await toolResult(providers, session, "untrusted-plan")).text).toContain("[not_available]");
    expect(readThreadPlan(session.thread().toThreadData().metadata)).toBeUndefined();
    await turn(session, "Hello again.");
    expect(seen[0]?.prompt).not.toContain("## Your current plan");
  });

  it("keeps the plan in thread metadata and shows it each turn, after compaction and a restore", async () => {
    const { faux, providers, options } = setup("plan-persist");
    const seen: { prompt: string; messages: string }[] = [];
    faux.setResponses([
      planCall("plan-1", ITEMS),
      capture(seen, "Planned."),
      capture(seen, "Working on the parser."),
      fauxAssistantMessage(COMPLETE_SUMMARY),
      capture(seen, "Still on the parser."),
      capture(seen, "Back after a restart."),
    ]);
    const session = await new Engine({ providers }).createSession(options);
    await turn(session, "Fix the parser bug.");

    expect(await toolResult(providers, session, "plan-1")).toEqual({ status: "completed", text: "Plan updated: 1 of 3 done. Now: Fix the parser" });
    const stored = await providers.store.getThread(session.id, session.thread().id);
    expect(readThreadPlan(stored?.metadata)).toEqual({ items: ITEMS, updatedAt: expect.any(Number) });
    // The turn that wrote the plan started without one.
    expect(seen[0]?.prompt).not.toContain("## Your current plan");

    await turn(session, "Continue.");
    expect(seen[1]?.prompt).toContain(OVERLAY);

    expect(await session.thread().compactThread({ mode: "manual" })).toBe("compacted");
    await turn(session, "Keep going.");
    // The tool call is gone from the transcript, and the overlay still shows the plan.
    expect(seen[2]?.messages).not.toContain("update_plan");
    expect(seen[2]?.prompt).toContain(OVERLAY);

    const restored = await new Engine({ providers }).restoreSession({ sessionId: session.id, options });
    expect(readThreadPlan(restored.thread().toThreadData().metadata)?.items).toEqual(ITEMS);
    await turn(restored, "Are you still there?");
    expect(seen[3]?.prompt).toContain(OVERLAY);
  });

  it("drops the overlay when every item is done", async () => {
    const { faux, providers, options } = setup("plan-done");
    const seen: { prompt: string; messages: string }[] = [];
    const done = ITEMS.map((item) => ({ ...item, status: "done" }));
    faux.setResponses([planCall("plan-1", ITEMS), fauxAssistantMessage("Planned."), planCall("plan-2", done), fauxAssistantMessage("All done."), capture(seen, "Anything else?")]);
    const session = await new Engine({ providers }).createSession(options);
    await turn(session, "Fix the parser bug.");
    await turn(session, "Finish it.");
    expect(await toolResult(providers, session, "plan-2")).toEqual({ status: "completed", text: "Plan updated: 3 of 3 done." });
    await turn(session, "Thanks.");
    expect(seen[0]?.prompt).not.toContain("## Your current plan");
    expect(session.thread().toThreadData().metadata?.[THREAD_PLAN_KEY]).toEqual({ items: done, updatedAt: expect.any(Number) });
  });

  it.each([
    ["no items", []],
    ["21 items", Array.from({ length: 21 }, () => ({ text: "Step", status: "pending" }))],
    ["blank text", [{ text: "   ", status: "pending" }]],
    ["text over 200 characters", [{ text: "x".repeat(201), status: "pending" }]],
    ["an unknown status", [{ text: "Ship it", status: "blocked" }]],
  ])("refuses %s and keeps the stored plan", async (_name, items) => {
    const { faux, providers, options } = setup(`plan-invalid-${_name}`);
    faux.setResponses([planCall("plan-1", ITEMS), planCall("plan-2", items), fauxAssistantMessage("Noted.")]);
    const session = await new Engine({ providers }).createSession(options);
    await turn(session, "Plan the fix.");
    expect((await toolResult(providers, session, "plan-2")).status).toBe("error");
    const stored = await providers.store.getThread(session.id, session.thread().id);
    expect(readThreadPlan(stored?.metadata)?.items).toEqual(ITEMS);
  });
});
