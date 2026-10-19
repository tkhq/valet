// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { StreamMessage } from "~/stores/stream";

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

const FILE = "/api/sessions/assistant%3Aasst_1/threads/th-1/files/e9339072-c505-4142-a1e0-b568a2356986";

function message(content: string, threadId: string): StreamMessage {
  return { id: "m1", sessionId: "assistant:asst_1", threadId, role: "assistant", content, parts: [], createdAt: Date.now() };
}

describe("MessageItem generated file links", () => {
  it("opens the conversation's own download on this page's hostname", () => {
    render(<TooltipProvider><MessageItem message={message(`[Form.docx](https://valet.example.com${FILE})`, "th-1")} /></TooltipProvider>);
    expect(screen.getByText("Form.docx").closest("a")?.getAttribute("href")).toBe(FILE);
  });

  it("keeps a download from another conversation on its own hostname", () => {
    render(<TooltipProvider><MessageItem message={message(`[Form.docx](https://valet.example.com${FILE})`, "th-2")} /></TooltipProvider>);
    expect(screen.getByText("Form.docx").closest("a")?.getAttribute("href")).toBe(`https://valet.example.com${FILE}`);
  });
});
