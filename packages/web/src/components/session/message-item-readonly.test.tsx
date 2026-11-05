// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { StreamMessage } from "~/stores/stream";
import { TooltipProvider } from "~/components/primitives";

const interactiveRenderer = vi.hoisted(() => vi.fn());
vi.mock("./tool-renderers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tool-renderers")>();
  return {
    ...actual,
    pickRenderer: (...args: Parameters<typeof actual.pickRenderer>) => {
      interactiveRenderer();
      return actual.pickRenderer(...args);
    },
  };
});

import { MessageItem } from "./message-item";

describe("read-only historical messages", () => {
  it("suppresses message actions even when callbacks and default ratings are available, and uses inert tool receipts", () => {
    const message: StreamMessage = {
      id: "historical", sessionId: "s1", threadId: "t1", role: "assistant", content: "Historical reply", createdAt: 1, completed: true,
      parts: [
        { kind: "text", text: "Historical reply" },
        { kind: "tool_call", callId: "tool-1", toolName: "browser", status: "completed", args: { action: "navigate", url: "https://example.test" }, result: { text: "Historical browser receipt" } },
      ],
    };
    const onEdit = vi.fn();
    const onBranch = vi.fn();
    const onReply = vi.fn();
    const { container } = render(<TooltipProvider><MessageItem message={message} readOnly onEdit={onEdit} onBranch={onBranch} onReply={onReply} /></TooltipProvider>);
    expect(screen.getByText("Historical reply")).toBeTruthy();
    expect(container.querySelector("form, input, textarea, select")).toBeNull();
    expect(screen.queryByRole("button", { name: /Edit message|Branch into|Reply to|Copy message|Good|Bad/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /browser/ }));
    expect(screen.getByText("Historical browser receipt")).toBeTruthy();
    expect(container.querySelector("form, input, textarea, select")).toBeNull();
    expect(interactiveRenderer).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
    expect(onBranch).not.toHaveBeenCalled();
    expect(onReply).not.toHaveBeenCalled();
  });
});
