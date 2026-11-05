// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "~/api/client";
import { ToolCallBlock, type ToolCallPart } from "./tool-call-block";

afterEach(() => vi.restoreAllMocks());

it("loads the full output of a trimmed result when its card renders", async () => {
  const load = vi.spyOn(api, "getToolOutput").mockResolvedValue({ result: { content: [{ type: "text", text: "the whole log" }] } });
  const part: ToolCallPart = {
    kind: "tool_call", callId: "c1", toolName: "bash", status: "completed", args: { command: "cat build.log" },
    result: { content: [{ type: "text", text: "the start [9 KB of output not shown] the end" }] },
    resultTrimmed: { chars: 20_000, entryId: "e1", threadId: "t1" },
  };
  render(<QueryClientProvider client={new QueryClient()}><ToolCallBlock part={part} /></QueryClientProvider>);
  await waitFor(() => expect(load).toHaveBeenCalledWith("t1", "e1", "c1"));
  // A finished card starts collapsed; open it as a person would.
  fireEvent.click(screen.getAllByRole("button").find((button) => button.getAttribute("aria-expanded") === "false")!);
  await waitFor(() => expect(screen.getAllByText(/the whole log/).length).toBeGreaterThan(0));
});

it("never loads anything for a result the transcript shipped whole", () => {
  const load = vi.spyOn(api, "getToolOutput");
  render(<ToolCallBlock part={{ kind: "tool_call", callId: "c2", toolName: "bash", status: "completed", result: { content: [{ type: "text", text: "ok" }] } }} />);
  expect(load).not.toHaveBeenCalled();
});
