// @vitest-environment jsdom
/** Home is the person's conversation with Valet, with Tasks and Make as tabs
 * on a phone. A wider screen shows it in the Threads layout with an idle view
 * and a Tasks panel. */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const home = vi.fn();
const needsYou = vi.fn(() => ({ count: 0, partial: false }));
const sessionView = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("~/api/home", () => ({ useHomeConversation: () => home() }));
vi.mock("~/components/home/tasks-panel", () => ({
  TasksPanel: () => <div data-testid="tasks" />,
  useNeedsYouCount: () => needsYou(),
}));
vi.mock("~/components/home/make-panel", () => ({ MakePanel: () => <div data-testid="make" /> }));
vi.mock("~/components/home/needs-you-dock", () => ({ NeedsYouDock: () => <div data-testid="dock" /> }));
let busy = false;
vi.mock("~/stores/stream", () => ({ useQueueStateForThread: () => undefined, queueBusy: () => busy }));
vi.mock("~/components/session/session-view", () => ({
  SessionView: (props: { sessionId: string; activeThreadId: string; active?: boolean; composerAccessory: React.ReactNode; cover?: React.ReactNode; headerActions?: React.ReactNode }) => {
    sessionView(props);
    return <div data-testid="chat" data-active={String(props.active ?? true)}>{props.headerActions}{props.cover}<textarea aria-label="Message" />{props.composerAccessory}</div>;
  },
}));

import { HomeScreen } from "~/components/home/home-screen";

const conversation = { data: { sessionId: "assistant:asst_1", threadId: "th-home" }, isError: false, error: null, refetch: vi.fn() };

describe("Home", () => {
  beforeEach(() => {
    localStorage.clear();
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

  it("shows the idle Home view over the desktop transcript until the person types", () => {
    render(<HomeScreen view="chat" wide onViewChange={vi.fn()} />);
    expect(sessionView.mock.lastCall?.[0]).not.toHaveProperty("panel");
    expect(screen.getByRole("button", { name: "Show conversation" })).toBeTruthy();
    // Only the greeting and starters: Tasks already lists what waits on the person.
    expect(within(screen.getByTestId("chat")).getByRole("heading", { level: 2 }).textContent).toMatch(/^(Good (morning|afternoon|evening)|Working late\?)$/);
    expect(screen.queryByText("Waiting on you")).toBeNull();
    expect(screen.queryByText("Recent work")).toBeNull();
    expect(screen.getByTestId("dock")).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    fireEvent.input(screen.getByRole("textbox", { name: "Message" }), { target: { value: "h" } });
    expect(screen.queryByRole("button", { name: "Show conversation" })).toBeNull();
  });

  it("gives way to the conversation on Show conversation or a running turn", () => {
    const { unmount } = render(<HomeScreen view="chat" wide onViewChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Show conversation" }));
    expect(screen.queryByRole("button", { name: "Show conversation" })).toBeNull();
    unmount();
    busy = true;
    render(<HomeScreen view="chat" wide onViewChange={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Show conversation" })).toBeNull();
    busy = false;
  });

  it("opens and closes the desktop Tasks panel from the header, and remembers the choice", () => {
    needsYou.mockReturnValue({ count: 2, partial: false });
    localStorage.setItem("valet:home-tasks-panel", "closed");
    const onViewChange = vi.fn();
    render(<HomeScreen view="chat" wide onViewChange={onViewChange} />);
    expect(screen.queryByTestId("tasks")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Tasks · 2" });
    fireEvent.click(toggle);
    expect(screen.getByRole("complementary", { name: "Tasks" })).toBeTruthy();
    expect(localStorage.getItem("valet:home-tasks-panel")).toBe("open");
    // The count shows whether the panel is open or closed.
    expect(screen.getByRole("button", { name: "Tasks · 2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close tasks" }));
    expect(screen.queryByTestId("tasks")).toBeNull();
    expect(localStorage.getItem("valet:home-tasks-panel")).toBe("closed");
  });

  it("restores a stored open choice even when nothing needs the person", () => {
    localStorage.setItem("valet:home-tasks-panel", "open");
    render(<HomeScreen view="chat" wide onViewChange={vi.fn()} />);
    expect(screen.getByTestId("tasks")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tasks" })).toBeTruthy();
  });

  it("opens the panel by default when no choice is stored", () => {
    needsYou.mockReturnValue({ count: 0, partial: false });
    render(<HomeScreen view="chat" wide onViewChange={vi.fn()} />);
    expect(screen.getByTestId("tasks")).toBeTruthy();
    expect(localStorage.getItem("valet:home-tasks-panel")).toBeNull();
  });

  it("keeps a stored closed choice over the default", () => {
    needsYou.mockReturnValue({ count: 3, partial: false });
    localStorage.setItem("valet:home-tasks-panel", "closed");
    render(<HomeScreen view="chat" wide onViewChange={vi.fn()} />);
    expect(screen.queryByTestId("tasks")).toBeNull();
    expect(screen.getByRole("button", { name: "Tasks · 3" })).toBeTruthy();
  });

  it("opens on ?view=tasks without storing a choice, and clears it on close", () => {
    localStorage.setItem("valet:home-tasks-panel", "closed");
    const onViewChange = vi.fn();
    render(<HomeScreen view="tasks" wide onViewChange={onViewChange} />);
    expect(screen.getByTestId("tasks")).toBeTruthy();
    expect(localStorage.getItem("valet:home-tasks-panel")).toBe("closed");
    fireEvent.click(screen.getByRole("button", { name: "Close tasks" }));
    expect(onViewChange).toHaveBeenCalledWith("chat");
  });

  it("offers Retry when the conversation cannot open", () => {
    const refetch = vi.fn();
    home.mockReturnValue({ data: undefined, isError: true, error: new Error("offline"), refetch });
    render(<HomeScreen view="chat" onViewChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });
});
