/**
 * Phase 0 spike: can pi-agent-core resume a turn from rehydrated SQLite state
 * with a fabricated tool result? See FINDINGS-continuation.md for results.
 *
 * Run (from repo root):
 *   set -a && source .env && set +a && \
 *   pnpm --filter @valet/engine exec tsx experiments/continuation-spike.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import {
  runAgentLoopContinue,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import {
  completeSimple,
  getModel,
  type AssistantMessage,
  type Message,
  type ToolCall,
  type ToolResultMessage,
  type UserMessage,
} from "@earendil-works/pi-ai/compat";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY missing. Run: set -a && source .env && set +a");
  process.exit(1);
}

const PRIMARY = getModel("anthropic", "claude-haiku-4-5" as never);
const THINKING = getModel("anthropic", "claude-sonnet-4-5" as never);

const calcTool: AgentTool = {
  name: "calc",
  label: "Calculator",
  description: "Evaluate an arithmetic expression and return the numeric result.",
  parameters: Type.Object({ expression: Type.String() }),
  execute: async (_id, params) => ({
    // If the loop ever calls this during a continuation, that is itself a
    // finding: continuation re-executed a tool instead of using history.
    content: [{ type: "text", text: `LIVE-EXEC:${JSON.stringify(params)}` }],
    details: undefined,
  }),
};

const loopConfig = (model: typeof PRIMARY): AgentLoopConfig => ({
  model,
  apiKey,
  convertToLlm: (messages) =>
    messages.filter(
      (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
    ) as Message[],
});

function userMsg(text: string): UserMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function toolCallsOf(msg: AssistantMessage): ToolCall[] {
  return msg.content.filter((c): c is ToolCall => c.type === "toolCall");
}

function fabricatedResult(call: ToolCall, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
}

/** Simulate SQLite persistence: serialize to a text file, read back, parse. */
function sqliteRoundTrip<T>(label: string, value: T): T {
  const dir = mkdtempSync(join(tmpdir(), "continuation-spike-"));
  const file = join(dir, `${label}.json`);
  writeFileSync(file, JSON.stringify(value));
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

async function continueLoop(
  context: AgentContext,
  model: typeof PRIMARY,
): Promise<{ final: AssistantMessage; events: AgentEvent["type"][]; toolExecuted: boolean }> {
  const events: AgentEvent["type"][] = [];
  let toolExecuted = false;
  const messages = await runAgentLoopContinue(context, loopConfig(model), (e) => {
    events.push(e.type);
    if (e.type === "tool_execution_start") toolExecuted = true;
  });
  const assistants = messages.filter(
    (m): m is AssistantMessage => m.role === "assistant",
  );
  assert.ok(assistants.length > 0, "continuation produced no assistant message");
  return { final: assistants[assistants.length - 1], events, toolExecuted };
}

async function captureDangling(
  model: typeof PRIMARY,
  prompt: string,
  opts: { reasoning?: "low" } = {},
): Promise<{ user: UserMessage; assistant: AssistantMessage }> {
  const user = userMsg(prompt);
  const assistant = await completeSimple(
    model,
    {
      systemPrompt: "You are a calculator assistant. Always use the calc tool for arithmetic.",
      messages: [user],
      tools: [calcTool],
    },
    { apiKey, ...opts },
  );
  return { user, assistant };
}

const results: string[] = [];
let failed = false;
function report(scenario: string, ok: boolean | "OBSERVED", detail: string): void {
  const tag = ok === "OBSERVED" ? "OBSERVED" : ok ? "PASS" : "FAIL";
  if (ok === false) failed = true;
  const line = `SCENARIO ${scenario}: ${tag} — ${detail}`;
  console.log(line);
  results.push(line);
}

// ---------------------------------------------------------------- Scenario A
const a = await captureDangling(PRIMARY, "What is 7 * 6? Use the calc tool.");
{
  const calls = toolCallsOf(a.assistant);
  report(
    "A",
    a.assistant.stopReason === "toolUse" && calls.length >= 1,
    `stopReason=${a.assistant.stopReason}, toolCalls=${calls.length}`,
  );
}

// ---------------------------------------------------------------- Scenario B
{
  const rehydrated = sqliteRoundTrip("b", [a.user, a.assistant] as Message[]);
  const call = toolCallsOf(rehydrated[1] as AssistantMessage)[0];
  const context: AgentContext = {
    systemPrompt: "You are a calculator assistant. Always use the calc tool for arithmetic.",
    messages: [...rehydrated, fabricatedResult(call, "42")],
    tools: [calcTool],
  };
  try {
    const { final, toolExecuted } = await continueLoop(context, PRIMARY);
    const text = final.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join(" ");
    report(
      "B",
      final.stopReason === "stop" && text.includes("42") && !toolExecuted,
      `stopReason=${final.stopReason}, mentions42=${text.includes("42")}, reExecutedTool=${toolExecuted}`,
    );
  } catch (err) {
    report("B", false, `continuation threw: ${String(err)}`);
  }
}

// --------------------------------------------------------------- Scenario B2
{
  const rehydrated = sqliteRoundTrip("b2", [a.user, a.assistant] as Message[]);
  const call = toolCallsOf(rehydrated[1] as AssistantMessage)[0];
  const context: AgentContext = {
    systemPrompt: "You are a calculator assistant. Always use the calc tool for arithmetic.",
    messages: [...rehydrated, fabricatedResult(call, "99")],
    tools: [calcTool],
  };
  try {
    const { final, toolExecuted } = await continueLoop(context, PRIMARY);
    const text = final.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join(" ");
    const trusted = final.stopReason === "stop" && text.includes("99") && !toolExecuted;
    if (trusted) {
      report(
        "B2",
        true,
        `stopReason=${final.stopReason}, mentions99=true, reExecutedTool=${toolExecuted} — model trusted the fabricated (wrong) result over its own arithmetic`,
      );
    } else if (final.stopReason === "stop" && !text.includes("99")) {
      const excerpt = text.slice(0, 200);
      report(
        "B2",
        "OBSERVED",
        `stopReason=${final.stopReason}, mentions99=false, reExecutedTool=${toolExecuted} — model did NOT adopt the contradictory fabricated value; text excerpt: "${excerpt}"`,
      );
    } else {
      report(
        "B2",
        "OBSERVED",
        `stopReason=${final.stopReason}, mentions99=${text.includes("99")}, reExecutedTool=${toolExecuted}`,
      );
    }
  } catch (err) {
    report("B2", "OBSERVED", `continuation threw: ${String(err)}`);
  }
}

// ---------------------------------------------------------------- Scenario C
{
  const c = await captureDangling(
    PRIMARY,
    "Compute 3 * 5 and 10 * 10. Call the calc tool twice, once per expression, in a single response.",
  );
  const calls = toolCallsOf(c.assistant);
  if (calls.length < 2) {
    report("C", "OBSERVED", `model made ${calls.length} tool call(s); parallel injection untested — retry with a stronger prompt before recording`);
  } else {
    const rehydrated = sqliteRoundTrip("c", [c.user, c.assistant] as Message[]);
    const rcalls = toolCallsOf(rehydrated[1] as AssistantMessage);
    const context: AgentContext = {
      systemPrompt: "You are a calculator assistant. Always use the calc tool for arithmetic.",
      messages: [
        ...rehydrated,
        fabricatedResult(rcalls[0], "15"),
        fabricatedResult(rcalls[1], "100"),
      ],
      tools: [calcTool],
    };
    try {
      const { final, toolExecuted } = await continueLoop(context, PRIMARY);
      const text = final.content
        .filter((cc) => cc.type === "text")
        .map((cc) => cc.text)
        .join(" ");
      report(
        "C",
        final.stopReason === "stop" && text.includes("15") && text.includes("100") && !toolExecuted,
        `stopReason=${final.stopReason}, mentionsBoth=${text.includes("15") && text.includes("100")}, reExecutedTool=${toolExecuted}`,
      );
    } catch (err) {
      report("C", false, `continuation threw: ${String(err)}`);
    }
  }
}

// ---------------------------------------------------------------- Scenario D
{
  const d = await captureDangling(THINKING, "What is 12 * 12? Use the calc tool.", {
    reasoning: "low",
  });
  const hasThinking = d.assistant.content.some((c) => c.type === "thinking");
  const call = toolCallsOf(d.assistant)[0];
  if (!call) {
    report("D", "OBSERVED", "no tool call captured on thinking model; rerun before recording");
  } else {
    const rehydrated = sqliteRoundTrip("d", [d.user, d.assistant] as Message[]);
    const makeCtx = (): AgentContext => ({
      systemPrompt: "You are a calculator assistant. Always use the calc tool for arithmetic.",
      messages: [...structuredClone(rehydrated), fabricatedResult(call, "144")],
      tools: [calcTool],
    });
    let sameModel = "untested";
    let switched = "untested";
    let switchedStripped = "untested";
    try {
      const r = await continueLoop(makeCtx(), THINKING);
      sameModel = `ok (stopReason=${r.final.stopReason})`;
    } catch (err) {
      sameModel = `threw: ${String(err)}`;
    }
    try {
      const r = await continueLoop(makeCtx(), PRIMARY);
      switched = `ok (stopReason=${r.final.stopReason})`;
    } catch (err) {
      switched = `threw: ${String(err)}`;
    }
    // Retry the switch with thinking blocks stripped from the assistant message.
    try {
      const ctx = makeCtx();
      const asst = ctx.messages[1] as AssistantMessage;
      asst.content = asst.content.filter((c) => c.type !== "thinking");
      const r = await continueLoop(ctx, PRIMARY);
      switchedStripped = `ok (stopReason=${r.final.stopReason})`;
    } catch (err) {
      switchedStripped = `threw: ${String(err)}`;
    }
    report(
      "D",
      "OBSERVED",
      `hasThinking=${hasThinking}; sameModel=${sameModel}; switched=${switched}; switchedThinkingStripped=${switchedStripped}`,
    );
  }
}

// ---------------------------------------------------------------- Scenario E
{
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    report("E", "OBSERVED", "SKIPPED — no OPENAI_API_KEY");
  } else {
    try {
      const oai = getModel("openai", "gpt-4o-mini" as never);
      const rehydrated = sqliteRoundTrip("e", [a.user, a.assistant] as Message[]);
      const call = toolCallsOf(rehydrated[1] as AssistantMessage)[0];
      const context: AgentContext = {
        systemPrompt: "You are a calculator assistant. Always use the calc tool for arithmetic.",
        messages: [...rehydrated, fabricatedResult(call, "42")],
        tools: [calcTool],
      };
      const events: AgentEvent["type"][] = [];
      const messages = await runAgentLoopContinue(
        context,
        { ...loopConfig(oai), apiKey: openaiKey },
        (e) => void events.push(e.type),
      );
      const finals = messages.filter((m): m is AssistantMessage => m.role === "assistant");
      const final = finals[finals.length - 1];
      report(
        "E",
        "OBSERVED",
        `anthropic→openai handoff: stopReason=${final?.stopReason}, errorMessage=${final?.errorMessage ?? "none"}`,
      );
    } catch (err) {
      report("E", "OBSERVED", `anthropic→openai handoff threw: ${String(err)}`);
    }
  }
}

console.log("\n--- summary ---");
for (const line of results) console.log(line);
process.exit(failed ? 1 : 0);
