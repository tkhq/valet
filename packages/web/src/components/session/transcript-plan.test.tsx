// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import type { ChildWorkSummary, MessagePart } from "@valet/api/wire";
import { describe, expect, it, vi } from "vitest";
import type { StreamMessage } from "~/stores/stream";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

import { AgentsLine, threadChildren } from "./agents-line";
import type { TranscriptItem } from "./signal-card";
import { planTranscript } from "./transcript-plan";

const AT = 1_000_000;
function msg(id: string, role: "user" | "assistant", parts: MessagePart[], extra: Partial<StreamMessage> = {}): TranscriptItem {
  const content = parts.filter(p => p.kind === "text").map(p => p.kind === "text" ? p.text : "").join("");
  return { kind: "message", message: { id, role, content, parts, createdAt: AT, model: "m", threadId: "t", completed: true, ...extra } as StreamMessage };
}
const tool = (callId: string, toolName = "bash"): MessagePart => ({ kind: "tool_call", callId, toolName, args: {}, status: "completed" });
const text = (t: string): MessagePart => ({ kind: "text", text: t });

describe("planTranscript", () => {
  it("folds a turn's tool-only steps into the work line above them", () => {
    const items = [
      msg("u", "user", [text("go")]),
      msg("a1", "assistant", [text("On it."), tool("c1")], { createdAt: AT + 1_000 }),
      msg("a2", "assistant", [tool("c2")], { createdAt: AT + 2_000 }),
      msg("a3", "assistant", [tool("c3"), text("Found it.")], { createdAt: AT + 3_000 }),
    ];
    const plans = planTranscript(items, false);
    expect(plans[1]!.extraWork.map(p => p.kind === "tool_call" && p.callId)).toEqual(["c2", "c3"]);
    expect(plans[2]!.hidden).toBe(true);
    expect(plans[3]).toMatchObject({ hidden: false, absorbedLeading: 1 });
  });

  it("keeps a step that has no work line above it, or that another model wrote", () => {
    const items = [
      msg("a1", "assistant", [text("Here.")]),
      msg("a2", "assistant", [tool("c2")], { createdAt: AT + 1_000 }),
      msg("a3", "assistant", [tool("c3")], { createdAt: AT + 2_000, model: "other" }),
    ];
    const plans = planTranscript(items, false);
    expect(plans.map(p => p.hidden)).toEqual([false, false, false]);
    expect(plans[2]!.absorbedLeading).toBe(0);
  });

  it("marks the work line live while the folded step still streams", () => {
    const items = [msg("a1", "assistant", [tool("c1")]), msg("a2", "assistant", [tool("c2")], { createdAt: AT + 1, completed: false })];
    expect(planTranscript(items, true)[0]!.extraWorkLive).toBe(true);
  });

  it("says how long a finished turn worked, on its last reply", () => {
    const items = [
      msg("u", "user", [text("go")]),
      msg("a1", "assistant", [tool("c1")], { createdAt: AT + 5_000 }),
      msg("a2", "assistant", [text("Done.")], { createdAt: AT + 192_000 }),
      msg("u2", "user", [text("thanks")], { createdAt: AT + 200_000 }),
      msg("a3", "assistant", [text("Any time.")], { createdAt: AT + 201_000 }),
    ];
    const plans = planTranscript(items, false);
    expect(plans[2]!.workedForMs).toBe(192_000);
    expect(plans.filter(p => p.workedForMs !== undefined)).toHaveLength(1);
    expect(planTranscript(items.slice(0, 3), true)[2]!.workedForMs).toBeUndefined();
  });
});

function child(sessionId: string, status: "running" | "settled", extra: Partial<ChildWorkSummary> = {}): ChildWorkSummary {
  return { sessionId, title: `Child ${sessionId}`, parentThreadId: "t1", status, createdAt: 1, ...extra };
}

describe("AgentsLine", () => {
  it("lists this thread's agents, running first", () => {
    const list = threadChildren([child("a", "settled"), child("b", "running"), child("c", "running", { parentThreadId: "t2" })], "t1");
    expect(list.map(c => c.sessionId)).toEqual(["b", "a"]);
  });

  it("shows nothing once every agent has finished", () => {
    const { container } = render(<AgentsLine children={[child("a", "settled")]} threadId="t1" />);
    expect(container.firstChild).toBeNull();
  });

  it("counts the running agents, names the first, and opens one", () => {
    const onOpenChild = vi.fn();
    render(<AgentsLine children={[child("a", "running", { title: "Review retry coverage" }), child("b", "running"), child("c", "settled", { outcome: "failed" })]} threadId="t1" onOpenChild={onOpenChild} />);
    fireEvent.click(screen.getByRole("button", { name: "Show the agents" }));
    expect(screen.getByText("2 agents working · Review retry coverage")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Child c" }));
    expect(onOpenChild).toHaveBeenCalledWith("c");
  });
});
