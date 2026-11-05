// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ThreadContextResponse } from "@valet/api/wire";
import { ContextMeter } from "./context-meter";

const reading: { current: ThreadContextResponse | undefined } = { current: undefined };
const sendState = { pending: false };
const sendMutateAsync = vi.fn();

vi.mock("~/api/thread-context", () => ({
  useThreadContext: () => ({ data: reading.current }),
}));

vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return { ...actual, useSendPrompt: () => ({ isPending: sendState.pending, mutateAsync: sendMutateAsync }) };
});

function context(tokens: number, extra?: Partial<NonNullable<ThreadContextResponse["context"]>>): ThreadContextResponse {
  return { context: { tokens, limit: 200_000, contextWindow: 220_000, model: "anthropic/claude-sonnet-4-6", autoCompact: true, ...extra } };
}

beforeEach(() => {
  reading.current = undefined;
  sendState.pending = false;
  sendMutateAsync.mockReset().mockResolvedValue({ messageId: null, threadId: "t1" });
});
afterEach(cleanup);

describe("ContextMeter", () => {
  it("renders nothing while the reading loads or when the model has no context window", () => {
    const { container, rerender } = render(<ContextMeter sessionId="s1" threadId="t1" working={false} />);
    expect(container.innerHTML).toBe("");
    reading.current = { context: null };
    rerender(<ContextMeter sessionId="s1" threadId="t1" working={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the share of the compaction budget, amber from 80%, and never past 100%", () => {
    reading.current = context(84_000);
    const { rerender } = render(<ContextMeter sessionId="s1" threadId="t1" working={false} />);
    const meter = screen.getByRole("button", { name: "Context 42% full" });
    expect(meter.className).toContain("text-muted");

    reading.current = context(170_000);
    rerender(<ContextMeter sessionId="s1" threadId="t1" working={false} />);
    expect(screen.getByRole("button", { name: "Context 85% full" }).className).toContain("text-amber-500");

    reading.current = context(260_000);
    rerender(<ContextMeter sessionId="s1" threadId="t1" working={false} />);
    expect(screen.getByRole("button", { name: "Context 100% full" })).toBeTruthy();
  });

  it("explains the reading and runs /compact in this thread", async () => {
    reading.current = context(84_000);
    render(<ContextMeter sessionId="s1" threadId="t1" working={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Context 42% full" }));

    expect(screen.getByText("84k of 200k tokens on claude-sonnet-4-6.")).toBeTruthy();
    expect(screen.getByText(/the assistant compacts the thread/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Compact now" }));

    expect(sendMutateAsync).toHaveBeenCalledWith({ text: "/compact", threadId: "t1" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Compact now" })).toBeNull());
  });

  it("waits for a running turn before it compacts", () => {
    reading.current = context(84_000);
    render(<ContextMeter sessionId="s1" threadId="t1" working />);
    fireEvent.click(screen.getByRole("button", { name: "Context 42% full" }));
    const compact = screen.getByRole<HTMLButtonElement>("button", { name: "Compact now" });
    expect(compact.disabled).toBe(true);
    expect(compact.title).toBe("Wait for the current turn to finish.");
  });

  it("keeps the popover open with the server's message when the command fails", async () => {
    reading.current = context(84_000);
    sendMutateAsync.mockRejectedValueOnce(new Error("Network down"));
    render(<ContextMeter sessionId="s1" threadId="t1" working={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Context 42% full" }));
    fireEvent.click(screen.getByRole("button", { name: "Compact now" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Network down. Check the server is running, then try again.");
    expect(screen.getByRole("button", { name: "Compact now" })).toBeTruthy();
  });

  it("says when the session does not compact by itself", () => {
    reading.current = context(84_000, { autoCompact: false });
    render(<ContextMeter sessionId="s1" threadId="t1" working={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Context 42% full" }));
    expect(screen.getByText(/Automatic compaction is off for this session/)).toBeTruthy();
  });
});
