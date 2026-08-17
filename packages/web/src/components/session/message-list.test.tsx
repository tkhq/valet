// @vitest-environment jsdom
/**
 * MessageList routing (decision 3): a message with `.signal` set must be
 * handed to `SignalCard`, never `MessageItem` — that's the mechanism that
 * keeps a `child.settled` notification from rendering as a fake "You"
 * bubble. Child renderers are stubbed so this test only covers the
 * routing decision, not their internals (covered by their own tests).
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { StreamMessage } from "~/stores/stream";
import { MessageList } from "./message-list";

vi.mock("./message-item", () => ({
  MessageItem: ({ message }: { message: StreamMessage }) => (
    <div data-testid="message-item">{message.id}</div>
  ),
}));
vi.mock("./signal-card", () => ({
  SignalCard: ({ message }: { message: StreamMessage }) => (
    <div data-testid="signal-card">{message.id}</div>
  ),
}));

function msg(overrides: Partial<StreamMessage> = {}): StreamMessage {
  return {
    id: "m1",
    sessionId: "s1",
    threadId: "t1",
    role: "assistant",
    content: "hello",
    parts: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("MessageList signal routing", () => {
  it("renders a plain message via MessageItem", () => {
    render(<MessageList messages={[msg({ id: "plain" })]} threadId="t1" />);
    expect(screen.getByTestId("message-item").textContent).toBe("plain");
    expect(screen.queryByTestId("signal-card")).toBeNull();
  });

  it("renders a signal-bearing message via SignalCard, not MessageItem", () => {
    render(
      <MessageList
        messages={[msg({ id: "sig", signal: { signalType: "child.settled" } })]}
        threadId="t1"
      />,
    );
    expect(screen.getByTestId("signal-card").textContent).toBe("sig");
    expect(screen.queryByTestId("message-item")).toBeNull();
  });

  it("routes each message independently in a mixed list", () => {
    render(
      <MessageList
        messages={[
          msg({ id: "plain-1" }),
          msg({ id: "sig-1", signal: { signalType: "reminder.due" } }),
          msg({ id: "plain-2" }),
        ]}
        threadId="t1"
      />,
    );
    expect(screen.getAllByTestId("message-item").map((el) => el.textContent)).toEqual([
      "plain-1",
      "plain-2",
    ]);
    expect(screen.getByTestId("signal-card").textContent).toBe("sig-1");
  });
});

/**
 * V1 port #12 — the jump-to-bottom control. Stick-to-bottom was ported with
 * the same 80px threshold, but a reader who scrolled up had no way back
 * except dragging the bar to the end of a long transcript.
 *
 * jsdom does no layout, so `scrollHeight`/`clientHeight` are 0 unless set.
 * These tests define them on the scroller and fire `scroll` by hand, which
 * is what the component actually reads.
 */
describe("MessageList jump-to-bottom", () => {
  /** The scroll container: the only element with `overflow-y-auto`. */
  function scroller(container: HTMLElement): HTMLElement {
    const el = container.querySelector(".overflow-y-auto");
    if (!(el instanceof HTMLElement)) throw new Error("no scroll container rendered");
    return el;
  }

  /** Places the scroller `distanceFromBottom` px above the end. */
  function scrollTo(el: HTMLElement, distanceFromBottom: number): void {
    Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
    el.scrollTop = 1000 - 400 - distanceFromBottom;
    fireEvent.scroll(el);
  }

  it("stays hidden while the list is at the bottom", () => {
    const { container } = render(<MessageList messages={[msg()]} threadId="t1" />);
    expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();

    // Inside the 80px "near bottom" band — still no button.
    scrollTo(scroller(container), 40);
    expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();
  });

  it("appears once the reader scrolls past the threshold", () => {
    const { container } = render(<MessageList messages={[msg()]} threadId="t1" />);
    scrollTo(scroller(container), 300);
    expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeTruthy();
  });

  it("returns to the bottom and hides itself on click", () => {
    const { container } = render(<MessageList messages={[msg()]} threadId="t1" />);
    const el = scroller(container);
    scrollTo(el, 300);

    fireEvent.click(screen.getByRole("button", { name: "Jump to latest message" }));

    expect(el.scrollTop).toBe(1000);
    // A programmatic scroll on a list already at the end fires no scroll
    // event, so the click itself has to clear the button.
    expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();
  });

  it("never renders on an empty thread", () => {
    render(<MessageList messages={[]} threadId="t1" />);
    expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();
  });
});
