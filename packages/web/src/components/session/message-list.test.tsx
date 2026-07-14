// @vitest-environment jsdom
/**
 * MessageList routing (decision 3): a message with `.signal` set must be
 * handed to `SignalCard`, never `MessageItem` — that's the mechanism that
 * keeps a `child.settled` notification from rendering as a fake "You"
 * bubble. Child renderers are stubbed so this test only covers the
 * routing decision, not their internals (covered by their own tests).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
