// @vitest-environment jsdom
/**
 * Render coverage for the per-message copy button.
 *
 * `messageCopyText` decides WHAT gets copied and is unit-tested in
 * `message-item.test.ts`. These tests cover the wiring that file cannot
 * see: that the button is rendered at all, that clicking it reaches the
 * clipboard, and that the empty-string result actually suppresses it.
 * Without them the whole button could be deleted from `MessageItem` and
 * the suite would stay green.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { StreamMessage } from "~/stores/stream";
import { MessageItem } from "./message-item";

function msg(over: Partial<StreamMessage> = {}): StreamMessage {
  return {
    id: "m1",
    sessionId: "s1",
    threadId: "t1",
    role: "assistant",
    content: "",
    parts: [],
    createdAt: Date.now(),
    ...over,
  };
}

describe("MessageItem copy button", () => {
  it("copies the message text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<MessageItem message={msg({ parts: [{ kind: "text", text: "The answer is 42" }] })} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("The answer is 42");
  });

  it("copies a user message too", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<MessageItem message={msg({ role: "user", content: "run the migration" })} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("run the migration");
  });

  it("shows no button on a message with no text to copy", () => {
    // A tool-only assistant turn. Each tool card carries its own copy
    // button, so a message-level one here would copy an empty string.
    render(
      <MessageItem
        message={msg({
          parts: [
            {
              kind: "tool_call",
              callId: "c1",
              toolName: "bash",
              args: { command: "ls" },
              status: "completed",
            },
          ],
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
  });
});
