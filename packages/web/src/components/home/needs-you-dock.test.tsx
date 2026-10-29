// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionGate } from "@valet/api/wire";
import { NeedsYouDock } from "./needs-you-dock";

const question: DecisionGate = { id: "question-1", sessionId: "session-1", threadId: "thread-1", type: "question", title: "Which website?", actions: [], status: "pending", createdAt: 0, updatedAt: 0 };
let gates = [question];
vi.mock("~/api/queries", () => ({ useResolveDecision: () => ({ isPending: false, mutateAsync: vi.fn() }), useWithdrawDecision: () => ({ isPending: false, mutateAsync: vi.fn() }), useNotificationDecisions: () => ({ data: { items: gates.map(gate => ({ gate, title: "Assistant", sessionId: gate.sessionId })) } }) }));
vi.mock("~/api/workflows", () => ({ useWorkflowActionRequired: () => ({ data: { count: 0 } }) }));
vi.mock("~/api/settings", () => ({ useMe: () => ({ data: { id: "me", orgRole: "member" } }) }));
vi.mock("~/components/session/gate-outcome", () => ({ rememberGateChoice: vi.fn(), useResolvedGateNotice: () => undefined, ResolvedGateNotice: () => null }));

describe("NeedsYouDock", () => {
  beforeEach(() => { gates = [question]; });
  it("labels questions accurately and restores the composer after deferring", () => {
    const expanded = vi.fn();
    render(<NeedsYouDock onOpenTasks={() => {}} onQuestionExpandedChange={expanded} />);
    expect(screen.getByText("Question 1 of 1 · Assistant")).toBeTruthy();
    expect(expanded).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(expanded).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("textbox", { name: "Your answer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(expanded).toHaveBeenLastCalledWith(true);
  });
  it("keeps an unfinished answer when Not now restores the composer", () => {
    const expanded = vi.fn();
    render(<NeedsYouDock onOpenTasks={() => {}} onQuestionExpandedChange={expanded} />);
    const answer = screen.getByRole("textbox", { name: "Your answer" });
    fireEvent.change(answer, { target: { value: "Keep these details" } });
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(expanded).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("textbox", { name: "Your answer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(expanded).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("textbox", { name: "Your answer" })).toBe(answer);
    expect(answer).toHaveProperty("value", "Keep these details");
  });
  it("restores the composer when a request resolves elsewhere", () => {
    const expanded = vi.fn();
    const props = { onOpenTasks: () => {}, onQuestionExpandedChange: expanded };
    const view = render(<NeedsYouDock {...props} />);
    gates = [];
    view.rerender(<NeedsYouDock {...props} />);
    expect(expanded).toHaveBeenLastCalledWith(false);
  });
  it("keeps ordinary approvals visible without taking over the composer", () => {
    gates = [{ ...question, id: "approval-1", type: "approval", actions: [{ id: "approve", label: "Approve once" }] }];
    const answering = vi.fn();
    render(<NeedsYouDock onOpenTasks={() => {}} onQuestionExpandedChange={answering} />);
    expect(screen.getByRole("button", { name: "Approve once" })).toBeTruthy();
    expect(answering).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(answering).toHaveBeenLastCalledWith(false);
  });
  it("excludes the current thread's own request", () => {
    const expanded = vi.fn();
    render(<NeedsYouDock homeThreadId="thread-1" onOpenTasks={() => {}} onQuestionExpandedChange={expanded} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(expanded).toHaveBeenLastCalledWith(false);
  });
});
