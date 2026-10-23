// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "~/components/primitives";
import { ThreadStateMark, threadRowState, type ThreadRowSignals, type ThreadRowState } from "./thread-state-mark";

const QUIET: ThreadRowSignals = { pendingGate: false, status: "idle", busy: false, unread: false };

describe("threadRowState", () => {
  const cases: Array<[string, Partial<ThreadRowSignals>, ThreadRowState]> = [
    ["a quiet thread", {}, "none"],
    ["an unread thread", { unread: true }, "unread"],
    ["a running turn over unread", { status: "streaming", unread: true }, "working"],
    ["a busy queue on an idle status", { busy: true, unread: true }, "working"],
    ["a failure over a busy queue", { status: "error", busy: true, unread: true }, "failed"],
    ["a pending gate over a failure", { pendingGate: true, status: "error", busy: true, unread: true }, "needs_you"],
    ["an open question over a running turn", { question: "Merge it?", status: "thinking", unread: true }, "needs_you"],
  ];
  it.each(cases)("shows %s as one state", (_name, signals, state) => {
    expect(threadRowState({ ...QUIET, ...signals })).toBe(state);
  });
});

function renderMark(state: ThreadRowState, question?: string) {
  return render(<TooltipProvider><ThreadStateMark state={state} question={question} /></TooltipProvider>);
}

describe("ThreadStateMark", () => {
  it("shows nothing for a quiet thread", () => {
    const { container } = renderMark("none");
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("shows three moving dots that stop under reduced motion while the thread works", () => {
    renderMark("working");
    const mark = screen.getByRole("img", { name: "Working" });
    const dots = [...mark.children];
    expect(dots).toHaveLength(3);
    for (const dot of dots) expect(dot.className).toContain("motion-reduce:animate-none");
  });

  it("names each dot state", () => {
    const { unmount } = renderMark("needs_you");
    expect(screen.getByRole("img", { name: "Needs approval" })).toBeTruthy();
    unmount();
    renderMark("needs_you", "Merge it once CI passes?");
    expect(screen.getByRole("img", { name: "Valet asked you a question" })).toBeTruthy();
  });

  it("labels a failed and an unread thread", () => {
    const { unmount } = renderMark("failed");
    expect(screen.getByRole("img", { name: "Thread failed" })).toBeTruthy();
    unmount();
    renderMark("unread");
    expect(screen.getByRole("img", { name: "Unread" })).toBeTruthy();
  });
});

describe("a turn blocked on an approval", () => {
  it("needs you before the approval itself has loaded", () => {
    expect(threadRowState({ pendingGate: false, status: "blocked_on_decision_gate", busy: true, unread: false })).toBe("needs_you");
  });
});
