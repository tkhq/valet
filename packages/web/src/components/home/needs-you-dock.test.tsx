// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionGate } from "@valet/api/wire";
import { NeedsYouDock } from "./needs-you-dock";

const question: DecisionGate = { id: "question-1", sessionId: "session-1", threadId: "thread-1", type: "question", title: "Which website?", actions: [], status: "pending", createdAt: 0, updatedAt: 0 };
let gates = [question];
let owners: Record<string, "user" | "team" | "org"> = {};
let workflowItems: Array<{ owner: { type: "user" | "team" | "org"; id: string } }> = [];
vi.mock("~/api/queries", () => ({ useResolveDecision: () => ({ isPending: false, mutateAsync: vi.fn() }), useWithdrawDecision: () => ({ isPending: false, mutateAsync: vi.fn() }), useNotificationDecisions: () => ({ data: { items: gates.map(gate => ({ gate, title: "Assistant", sessionId: gate.sessionId, owner: { type: owners[gate.id] ?? "user", id: "o" } })) } }) }));
vi.mock("~/api/workflows", () => ({ useWorkflowActionRequired: () => ({ data: { count: workflowItems.length, items: workflowItems } }) }));
vi.mock("~/api/settings", () => ({ useMe: () => ({ data: { id: "me", orgRole: "member" } }) }));
const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate, Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock("~/components/session/gate-outcome", () => ({ rememberGateChoice: vi.fn(), useResolvedGateNotice: () => undefined, ResolvedGateNotice: () => null }));

describe("NeedsYouDock", () => {
  beforeEach(() => { gates = [question]; owners = {}; workflowItems = []; navigate.mockClear(); });
  const approval = (id: string, threadId: string): DecisionGate => ({ ...question, id, threadId, type: "approval", title: "Send it?", actions: [{ id: "approve", label: "Approve once" }] });
  it("opens the request's thread after the last waiting request is answered", async () => {
    gates = [approval("gate-a", "thread-a")];
    render(<NeedsYouDock onOpenTasks={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/threads/$threadId", params: { threadId: "thread-a" } }));
  });
  it("stays on Home while other requests still wait", async () => {
    gates = [approval("gate-a", "thread-a"), approval("gate-b", "thread-b")];
    render(<NeedsYouDock onOpenTasks={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(navigate).not.toHaveBeenCalled();
  });
  it("hides team approvals on a phone Home but keeps personal ones", () => {
    gates = [{ ...question, id: "team-gate", type: "approval", actions: [{ id: "approve", label: "Approve once" }] }, { ...question, id: "mine" }];
    owners = { "team-gate": "team" };
    render(<NeedsYouDock personalOnly onOpenTasks={() => {}} />);
    expect(screen.getByText("Question 1 of 1 · Assistant")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve once" })).toBeNull();
  });
  it("hides org-owned approvals and org-owned workflow gates on a phone Home", () => {
    owners = { "question-1": "org" };
    workflowItems = [{ owner: { type: "org", id: "o" } }];
    const { container } = render(<NeedsYouDock personalOnly onOpenTasks={() => {}} />);
    expect(container.textContent).toBe("");
  });
  it("counts personal workflow gates on a phone Home", () => {
    owners = { "question-1": "team" };
    workflowItems = [{ owner: { type: "user", id: "me" } }, { owner: { type: "org", id: "o" } }];
    render(<NeedsYouDock personalOnly onOpenTasks={() => {}} />);
    expect(screen.getByText("1 request is waiting")).toBeTruthy();
  });
  it("renders nothing on a phone Home when only team work waits", () => {
    owners = { "question-1": "team" };
    workflowItems = [{ owner: { type: "team", id: "t" } }];
    const { container } = render(<NeedsYouDock personalOnly onOpenTasks={() => {}} />);
    expect(container.textContent).toBe("");
  });
  it("still shows team approvals when not personal only", () => {
    owners = { "question-1": "team" };
    render(<NeedsYouDock onOpenTasks={() => {}} />);
    expect(screen.getByText("Question 1 of 1 · Assistant")).toBeTruthy();
  });
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
