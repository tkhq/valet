import { describe, expect, it } from "vitest";
import type { StreamMessage } from "~/stores/stream";
import { promptHistory, stepHistory } from "./prompt-history";

function message(id: string, content: string, extra?: Partial<StreamMessage>): StreamMessage {
  return { id, sessionId: "s1", threadId: "t1", role: "user", content, parts: [], createdAt: 1, ...extra };
}

describe("promptHistory", () => {
  const mine = { author: { id: "u1" } };

  it("keeps the viewer's prompts in this thread, oldest first, without a repeat in a row", () => {
    expect(promptHistory([
      message("m1", "first", mine),
      message("m2", "reply", { role: "assistant" }),
      message("m3", "other thread", { ...mine, threadId: "t2" }),
      message("m4", " second \n", mine),
      message("m5", "second", mine),
      message("m6", "teammate", { author: { id: "u2", name: "Pat" } }),
      message("m7", "channel sender", { author: { id: "u1", name: "Slack person", externalSender: true } }),
      message("m8", "child settled", { ...mine, signal: { signalType: "child.settled" } }),
      message("m9", "mine, signed", mine),
      message("m10", "/compact", mine),
      message("m11", "   ", mine),
    ], "t1", "u1")).toEqual(["first", "second", "mine, signed", "/compact"]);
  });

  it("leaves out an unauthored message an agent wrote, but keeps the viewer's optimistic copy", () => {
    expect(promptHistory([
      message("m1", "Delegated brief: audit every workflow and report back."),
      message("m2", "just sent", { persistence: "optimistic" }),
    ], "t1", "u1")).toEqual(["just sent"]);
  });

  it("recalls a skill invocation as the slash command, not the expanded skill body", () => {
    expect(promptHistory([
      message("m1", "<skill name=\"review\">Long review instructions…</skill>\n\nfix the bug", { ...mine, skill: { name: "review", args: "fix the bug" } }),
      message("m2", "<skill name=\"status\">Status instructions…</skill>", { ...mine, skill: { name: "status" } }),
    ], "t1", "u1")).toEqual(["/review fix the bug", "/status"]);
  });
});

describe("stepHistory", () => {
  const history = ["one", "two\nlines", "three"];
  const at = (n: number) => ({ start: n, end: n });

  it("walks older from an empty composer and newer back to empty", () => {
    let step = stepHistory(history, { index: null, text: "" }, "older", at(0));
    expect(step).toEqual({ index: 2, text: "three" });
    step = stepHistory(history, step!, "older", at(5));
    expect(step).toEqual({ index: 1, text: "two\nlines" });
    // The caret sits at the end of the recalled prompt, on its last line, so Up first moves within it.
    expect(stepHistory(history, step!, "older", at(9))).toBeUndefined();
    step = stepHistory(history, step!, "older", at(2));
    expect(step).toEqual({ index: 0, text: "one" });
    expect(stepHistory(history, step!, "older", at(3))).toBeUndefined();
    step = stepHistory(history, step!, "newer", at(3));
    expect(step).toEqual({ index: 1, text: "two\nlines" });
    expect(stepHistory(history, step!, "newer", at(1))).toBeUndefined();
    step = stepHistory(history, step!, "newer", at(9));
    expect(step).toEqual({ index: 2, text: "three" });
    expect(stepHistory(history, step!, "newer", at(5))).toEqual({ index: null, text: "" });
  });

  it("never replaces typed text and leaves Down alone outside a recall", () => {
    expect(stepHistory(history, { index: null, text: "draft" }, "older", at(0))).toBeUndefined();
    expect(stepHistory(history, { index: 2, text: "three, edited" }, "older", at(0))).toBeUndefined();
    expect(stepHistory(history, { index: null, text: "" }, "newer", at(0))).toBeUndefined();
    expect(stepHistory([], { index: null, text: "" }, "older", at(0))).toBeUndefined();
  });

  it("leaves a selection to the browser", () => {
    expect(stepHistory(history, { index: 2, text: "three" }, "older", { start: 0, end: 5 })).toBeUndefined();
  });
});
