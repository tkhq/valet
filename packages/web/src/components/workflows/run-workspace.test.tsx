// @vitest-environment jsdom
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RunWorkspace } from "./run-workspace";

vi.mock("~/components/session/session-view", () => ({
  SessionView: ({ sessionId, activeThreadId, active }: { sessionId: string; activeThreadId: string; active: boolean }) =>
    <div data-testid="chat" data-active={active} data-session={sessionId} data-thread={activeThreadId}><textarea aria-label="Message" /></div>,
}));
const conversations = [
  { sessionId: "execution:one", threadId: "th-one", title: "Prepare report" },
  { sessionId: "execution:two", threadId: "th-two", title: "Review report" },
];
function Preview() {
  const [view, setView] = useState<"conversation" | "details">("conversation");
  const [thread, setThread] = useState<string>();
  return <RunWorkspace conversations={conversations} view={view} conversationId={thread}
    onSelect={(next, id) => { setView(next); setThread(id); }}><button>Retry run</button></RunWorkspace>;
}
describe("automation run workspace", () => {
  it("keeps the chat mounted and its draft while inspecting run details", () => {
    render(<Preview />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Follow up" } });
    fireEvent.click(screen.getByRole("tab", { name: "Run details" }));
    expect(screen.getByRole("button", { name: "Retry run" })).toBeTruthy();
    expect(screen.getByTestId("chat").getAttribute("data-active")).toBe("false");
    fireEvent.click(screen.getByRole("tab", { name: "Conversation" }));
    expect(screen.getByRole("textbox", { name: "Message" }).getAttribute("aria-label")).toBe("Message");
    expect(screen.getByDisplayValue("Follow up")).toBeTruthy();
  });
  it("selects the exact run conversation without starting another workflow", () => {
    render(<Preview />);
    fireEvent.change(screen.getByRole("combobox", { name: "Run conversation" }), { target: { value: "th-two" } });
    expect(screen.getByTestId("chat").getAttribute("data-session")).toBe("execution:two");
    expect(screen.getByTestId("chat").getAttribute("data-thread")).toBe("th-two");
  });
  it("shows run details when no conversation exists", () => {
    render(<RunWorkspace conversations={[]} onSelect={vi.fn()}><button>Retry run</button></RunWorkspace>);
    expect(screen.getByRole("tab", { name: "Run details" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("chat")).toBeNull();
  });
});
