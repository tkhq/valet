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
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { StreamMessage } from "~/stores/stream";

const markdownRender = vi.hoisted(() => vi.fn());

vi.mock("~/components/markdown", () => ({
  Markdown: ({ children }: { children: string }) => {
    markdownRender(children);
    return <span>{children}</span>;
  },
}));

// The rating hooks need a QueryClient these renders don't mount; spread the
// real module so every other export stays present (see session-header.test.tsx).
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useSessionRatings: () => ({ data: { session: null, entries: {} }, isLoading: false, error: null }),
    useRateMessage: () => ({ isPending: false, mutate: vi.fn() }),
  };
});

import { TooltipProvider } from "~/components/primitives";
import { MessageItem } from "./message-item";

function renderItem(
  message: StreamMessage,
  onReply?: (target: { messageId: string; excerpt: string }) => void,
) {
  return render(itemTree(message, onReply));
}

function itemTree(
  message: StreamMessage,
  onReply?: (target: { messageId: string; excerpt: string }) => void,
) {
  return (
    <TooltipProvider>
      <MessageItem message={message} onReply={onReply} />
    </TooltipProvider>
  );
}

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
    renderItem(msg({ parts: [{ kind: "text", text: "The answer is 42" }] }));

    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("The answer is 42");
  });

  it("copies a user message too", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderItem(msg({ role: "user", content: "run the migration" }));

    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("run the migration");
  });

  it("shows no button on a message with no text to copy", () => {
    // A tool-only assistant turn. Each tool card carries its own copy
    // button, so a message-level one here would copy an empty string.
    renderItem(
      msg({
        parts: [
          {
            kind: "tool_call",
            callId: "c1",
            toolName: "bash",
            args: { command: "ls" },
            status: "completed",
          },
        ],
      }),
    );
    expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
  });
});

describe("MessageItem render isolation", () => {
  it("does not re-render unchanged Markdown when its parent renders again", () => {
    markdownRender.mockClear();
    const message = msg({ parts: [{ kind: "text", text: "stable history" }] });
    const view = renderItem(message);
    expect(markdownRender).toHaveBeenCalledTimes(1);

    view.rerender(itemTree(message));

    expect(markdownRender).toHaveBeenCalledTimes(1);
  });
});

describe("MessageItem replies", () => {
  it("offers Reply only for assistant text and returns a concise snapshot", () => {
    const onReply = vi.fn();
    renderItem(
      msg({
        id: "assistant-7",
        completed: true,
        parts: [{ kind: "text", text: "Use  the\nblue deployment." }],
      }),
      onReply,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reply to message" }));
    expect(onReply).toHaveBeenCalledWith({
      messageId: "assistant-7",
      excerpt: "Use the blue deployment.",
    });
  });

  it("does not offer Reply until the assistant message is complete", () => {
    renderItem(
      msg({ parts: [{ kind: "text", text: "Still streaming" }], completed: false }),
      vi.fn(),
    );

    expect(screen.queryByRole("button", { name: "Reply to message" })).toBeNull();
  });

  it("renders persisted quoted context on a user message", () => {
    renderItem(
      msg({
        role: "user",
        content: "What about staging?",
        replyTo: { messageId: "assistant-7", excerpt: "Use the blue deployment." },
      }),
    );

    expect(screen.getByText("Replying to Assistant")).toBeTruthy();
    expect(screen.getByText("Use the blue deployment.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reply to message" })).toBeNull();
  });
});


describe("structured assistant results", () => {
  const raw = JSON.stringify({ summary: "Found four cleanup candidates. No memory was changed.", candidates: [{ path: "notes.md", evidence: "Preserve unique history. ".repeat(100) }] });

  it("collapses a completed JSON result and preserves exact message copying", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderItem(msg({ completed: true, parts: [{ kind: "text", text: raw }] }));
    expect(screen.getByText(/Structured result/)).toBeTruthy();
    expect(screen.getByText("Found four cleanup candidates. No memory was changed.")).toBeTruthy();
    expect(screen.queryByText(raw)).toBeNull();
    const disclosure = screen.getByText(/Structured result/).closest("details");
    expect(disclosure).not.toBeNull();
    disclosure?.setAttribute("open", "");
    if (disclosure) fireEvent(disclosure, new Event("toggle"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy());
    expect(disclosure?.querySelector("code")?.textContent).toBe(raw);
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(raw);
  });

  it.each([
    { role: "user" as const, completed: true },
    { role: "assistant" as const, completed: false },
    { role: "assistant" as const, completed: true, stopReason: "error" as const },
  ])("keeps user, streaming and failed messages visible: %j", (state) => {
    renderItem(msg({ ...state, parts: [{ kind: "text", text: raw }] }));
    expect(screen.getByText(raw)).toBeTruthy();
    expect(screen.queryByText(/Structured result/)).toBeNull();
  });

  it.each([
    "Here is the result: " + raw,
    raw.slice(0, -1),
    JSON.stringify({ error: "Choose another model.", details: "x".repeat(1600) }),
    JSON.stringify({ status: "failed", details: "x".repeat(1600) }),
    JSON.stringify([{ error: "Choose another model.", details: "x".repeat(1600) }]),
  ])("does not hide prose, malformed JSON, or errors", (text) => {
    renderItem(msg({ completed: true, parts: [{ kind: "text", text }] }));
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByText(/Structured result/)).toBeNull();
  });
});

it("preserves JSON integer precision in expanded results", async () => {
  const raw = '{"id":9007199254740993,"details":"' + "x".repeat(1600) + '"}';
  renderItem(msg({ completed: true, content: raw }));
  const disclosure = screen.getByText(/Structured result/).closest("details");
  disclosure?.setAttribute("open", "");
  if (disclosure) fireEvent(disclosure, new Event("toggle"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy());
  expect(disclosure?.querySelector("code")?.textContent).toBe(raw);
});
