import { describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "@valet/engine/test-helpers";
import { interpolateTurnContent, runCase } from "../src/index.js";
import type { EvalCase } from "../src/index.js";

function modelOf(faux: ReturnType<typeof registerFauxProvider>): ReturnType<typeof faux.getModel> {
  return faux.getModel();
}

function makeCase(overrides: Partial<EvalCase>): EvalCase {
  return {
    id: "test-case",
    turns: [{ role: "user", content: "say hello" }],
    checks: [{ type: "no_errors" }],
    ...overrides,
  };
}

describe("interpolateTurnContent", () => {
  it("passes through content without templates", () => {
    expect(interpolateTurnContent("plain text", undefined)).toBe("plain text");
  });

  it("replaces last_output_match with the first capture group", () => {
    expect(interpolateTurnContent("use {{last_output_match(/id: (\\w+)/)}}", "the id: abc123 ok")).toBe(
      "use abc123",
    );
  });

  it("replaces with the whole match when there is no capture group", () => {
    expect(interpolateTurnContent("{{last_output_match(/\\d+/)}}", "answer 42")).toBe("42");
  });

  it("throws when used on the first turn", () => {
    expect(() => interpolateTurnContent("{{last_output_match(/x/)}}", undefined)).toThrow(
      /no previous agent output/,
    );
  });

  it("throws when the pattern does not match", () => {
    expect(() => interpolateTurnContent("{{last_output_match(/zzz/)}}", "abc")).toThrow(/did not match/);
  });
});

describe("runCase", () => {
  it("runs a single-turn prompt and extracts a trajectory", async () => {
    const faux = registerFauxProvider({ provider: "eval-run-1" });
    faux.setResponses([fauxAssistantMessage("hello, world")]);

    const result = await runCase(makeCase({}), { model: modelOf(faux) });

    expect(result.outcome).toBe("completed");
    expect(result.trajectory.finalOutput).toBe("hello, world");
    expect(result.trajectory.prompt).toBe("say hello");
    expect(result.trajectory.stopReason).toBe("end_turn");
    expect(result.trajectory.turns.length).toBeGreaterThanOrEqual(1);
    expect(result.trajectory.durationMs).toBeGreaterThanOrEqual(0);

    faux.unregister();
  });

  it("runs a two-turn conversation and captures entries from both turns", async () => {
    const faux = registerFauxProvider({ provider: "eval-run-2" });
    faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);

    const result = await runCase(
      makeCase({
        turns: [
          { role: "user", content: "question one" },
          { role: "user", content: "follow-up" },
        ],
      }),
      { model: modelOf(faux) },
    );

    expect(result.outcome).toBe("completed");
    expect(result.trajectory.finalOutput).toBe("second answer");
    expect(result.trajectory.turns).toHaveLength(2);

    faux.unregister();
  });

  it("interpolates a template from the previous turn's output", async () => {
    const faux = registerFauxProvider({ provider: "eval-run-3" });
    const prompts: string[] = [];
    faux.setResponses([
      fauxAssistantMessage("the token is XYZZY."),
      (context) => {
        const last = context.messages.filter((m) => m.role === "user").at(-1);
        const text =
          last && Array.isArray(last.content)
            ? last.content
                .map((b) => (typeof b === "object" && b !== null && "text" in b ? String(b.text) : ""))
                .join("")
            : String(last?.content ?? "");
        prompts.push(text);
        return fauxAssistantMessage("confirmed");
      },
    ]);

    const result = await runCase(
      makeCase({
        turns: [
          { role: "user", content: "emit a token" },
          { role: "user", content: "repeat {{last_output_match(/token is (\\w+)/)}}" },
        ],
      }),
      { model: modelOf(faux) },
    );

    expect(result.outcome).toBe("completed");
    expect(prompts.at(-1)).toContain("repeat XYZZY");

    faux.unregister();
  });

  it("records mem_* tool calls made against the eval memory store", async () => {
    const faux = registerFauxProvider({ provider: "eval-run-4" });
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("mem_write", { path: "notes/x.md", content: "fact" }, { id: "tc1" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [fauxToolCall("mem_read", { path: "notes/x.md" }, { id: "tc2" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("stored and verified"),
    ]);

    const result = await runCase(makeCase({}), { model: modelOf(faux) });

    expect(result.outcome).toBe("completed");
    const names = result.trajectory.toolCalls.map((c) => c.toolName);
    expect(names).toEqual(["mem_write", "mem_read"]);
    expect(result.trajectory.toolCalls.every((c) => c.status === "completed")).toBe(true);
    const readResult = result.trajectory.toolCalls[1].result as { text?: string };
    expect(readResult.text).toBe("fact");

    faux.unregister();
  });

  it("restricts the toolset when the case pins tools", async () => {
    const faux = registerFauxProvider({ provider: "eval-run-5" });
    let seenTools: string[] = [];
    faux.setResponses([
      (context) => {
        seenTools = (context.tools ?? []).map((t) => t.name);
        return fauxAssistantMessage("ok");
      },
    ]);

    const result = await runCase(makeCase({ tools: ["mem_write", "mem_read"] }), {
      model: modelOf(faux),
    });

    expect(result.outcome).toBe("completed");
    expect(seenTools.sort()).toEqual(["mem_read", "mem_write"]);

    faux.unregister();
  });

  it("rejects a case pinning unknown tools", async () => {
    const faux = registerFauxProvider({ provider: "eval-run-6" });
    await expect(
      runCase(makeCase({ tools: ["not_a_tool"] }), { model: modelOf(faux) }),
    ).rejects.toThrow(/unknown tools: not_a_tool/);
    faux.unregister();
  });

  it("orchestrator case: spawns a child via task and captures a child trajectory", async () => {
    const faux = registerFauxProvider({ provider: "eval-run-7" });
    // The faux queue is global while parent and child sessions call the
    // model concurrently — route by conversation content, not call order.
    const route = (context: { messages: Array<{ role: string; content: unknown }> }) => {
      const text = context.messages
        .map((m) => {
          if (typeof m.content === "string") return m.content;
          if (Array.isArray(m.content)) {
            return m.content
              .map((b) =>
                typeof b === "object" && b !== null && "text" in b ? String((b as { text: unknown }).text) : "",
              )
              .join("");
          }
          return "";
        })
        .join("\n");
      const lastUser = context.messages.filter((m) => m.role === "user").at(-1);
      const lastUserText =
        typeof lastUser?.content === "string"
          ? lastUser.content
          : Array.isArray(lastUser?.content)
            ? lastUser.content
                .map((b) =>
                  typeof b === "object" && b !== null && "text" in b ? String((b as { text: unknown }).text) : "",
                )
                .join("")
            : "";
      if (lastUserText.includes("add 2+2")) return fauxAssistantMessage("the answer is 4");
      if (lastUserText.includes("child_settled")) return fauxAssistantMessage("the child reported 4");
      if (text.includes("spawned child session")) return fauxAssistantMessage("child dispatched");
      return fauxAssistantMessage([fauxToolCall("task", { prompt: "add 2+2" }, { id: "spawn1" })], {
        stopReason: "toolUse",
      });
    };
    faux.setResponses([route, route, route, route]);

    const result = await runCase(
      makeCase({ session_type: "orchestrator", turns: [{ role: "user", content: "delegate this" }] }),
      { model: modelOf(faux) },
    );

    expect(result.outcome).toBe("completed");
    expect(result.trajectory.children).toHaveLength(1);
    const child = result.trajectory.children?.[0];
    expect(child?.prompt).toBe("add 2+2");
    expect(child?.finalOutput).toBe("the answer is 4");
    const spawnCall = result.trajectory.toolCalls.find((c) => c.toolName === "task");
    expect(spawnCall).toBeDefined();
    expect(child?.spawnedByCallId).toBe(spawnCall?.callId);
    // The parent processed the child.settled signal.
    expect(result.trajectory.finalOutput).toBe("the child reported 4");

    faux.unregister();
  });

  it("reports timeout as the outcome instead of throwing", async () => {
    const faux = registerFauxProvider({ provider: "eval-run-8", tokensPerSecond: 5 });
    const longText = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
    faux.setResponses([fauxAssistantMessage(longText)]);

    const result = await runCase(makeCase({ timeout_ms: 150 }), { model: modelOf(faux) });

    expect(result.outcome).toBe("timeout");
    expect(result.error).toMatch(/timed out/);

    faux.unregister();
  });

  it("rejects an unknown model spec with a corrective error", async () => {
    await expect(runCase(makeCase({}), { model: "made-up/not-real" })).rejects.toThrow(
      /unknown model spec/,
    );
  });
});

// Real-LLM smoke (TKAI-329 done-when). Skips without a key; `make e2e`
// scrubs provider keys, so this only runs when invoked directly with
// ANTHROPIC_API_KEY set.
describe.skipIf(!process.env.ANTHROPIC_API_KEY)("runCase (live LLM)", () => {
  it(
    "runs 'say hello' against a real model and reports usage",
    { timeout: 120_000 },
    async () => {
      const result = await runCase(
        makeCase({
          id: "live-hello",
          turns: [{ role: "user", content: "Reply with the single word hello." }],
          timeout_ms: 90_000,
        }),
        { model: "anthropic/claude-haiku-4-5" },
      );

      expect(result.outcome).toBe("completed");
      expect(result.trajectory.finalOutput.toLowerCase()).toContain("hello");
      expect(result.trajectory.usage.total).toBeGreaterThan(0);
    },
  );
});
