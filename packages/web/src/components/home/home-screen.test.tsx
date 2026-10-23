// @vitest-environment jsdom
/** The phone's Home is the person's conversation with Valet, with Tasks and
 * Make as tabs. */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const home = vi.fn();
const needsYou = vi.fn(() => ({ count: 0, partial: false }));
const sessionView = vi.fn();

vi.mock("~/api/home", () => ({ useHomeConversation: () => home() }));
vi.mock("~/components/home/tasks-panel", () => ({
  TasksPanel: () => <div data-testid="tasks" />,
  useNeedsYouCount: () => needsYou(),
}));
vi.mock("~/components/home/make-panel", () => ({ MakePanel: () => <div data-testid="make" /> }));
vi.mock("~/components/home/needs-you-dock", () => ({ NeedsYouDock: () => <div data-testid="dock" /> }));
vi.mock("~/components/session/session-view", () => ({
  SessionView: (props: { sessionId: string; activeThreadId: string; active: boolean; composerAccessory: React.ReactNode }) => {
    sessionView(props);
    return <div data-testid="chat" data-active={String(props.active)}>{props.composerAccessory}</div>;
  },
}));

import { HomeScreen } from "~/components/home/home-screen";

const conversation = { data: { sessionId: "assistant:asst_1", threadId: "th-home" }, isError: false, error: null, refetch: vi.fn() };

describe("Home", () => {
  beforeEach(() => {
    home.mockReturnValue(conversation);
    needsYou.mockReturnValue({ count: 0, partial: false });
    sessionView.mockReset();
  });

  it("opens the home thread in the conversation view, with the approvals dock above the composer", () => {
    render(<HomeScreen view="chat" onViewChange={vi.fn()} />);
    expect(sessionView).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "assistant:asst_1", activeThreadId: "th-home", active: true }));
    expect(screen.getByTestId("dock")).toBeTruthy();
    expect(screen.queryByTestId("tasks")).toBeNull();
  });

  it("switches to Tasks on a phone and keeps the conversation mounted", () => {
    const onViewChange = vi.fn();
    const { rerender } = render(<HomeScreen view="chat" onViewChange={onViewChange} />);
    fireEvent.click(screen.getByRole("tab", { name: "Tasks" }));
    expect(onViewChange).toHaveBeenCalledWith("tasks");
    rerender(<HomeScreen view="tasks" onViewChange={onViewChange} />);
    expect(screen.getByTestId("tasks")).toBeTruthy();
    expect(screen.getByTestId("chat").dataset.active).toBe("false");
  });

  it("counts what needs the person on the Tasks tab", () => {
    needsYou.mockReturnValue({ count: 3, partial: true });
    render(<HomeScreen view="chat" onViewChange={vi.fn()} />);
    expect(screen.getByRole("tab", { name: /Tasks/ }).textContent).toContain("3+");
  });

  it("switches to Make on a phone, in place of the conversation", () => {
    const onViewChange = vi.fn();
    const { rerender } = render(<HomeScreen view="chat" onViewChange={onViewChange} />);
    expect(screen.getAllByRole("tab").map(tab => tab.textContent)).toEqual(["Chat", "Tasks", "Make"]);
    fireEvent.click(screen.getByRole("tab", { name: "Make" }));
    expect(onViewChange).toHaveBeenCalledWith("make");
    rerender(<HomeScreen view="make" onViewChange={onViewChange} />);
    expect(screen.getByTestId("make")).toBeTruthy();
    expect(screen.queryByTestId("tasks")).toBeNull();
    expect(screen.getByTestId("chat").dataset.active).toBe("false");
  });

  it("offers Retry when the conversation cannot open", () => {
    const refetch = vi.fn();
    home.mockReturnValue({ data: undefined, isError: true, error: new Error("offline"), refetch });
    render(<HomeScreen view="chat" onViewChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });
});
