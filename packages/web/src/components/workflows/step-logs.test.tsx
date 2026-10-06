// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "~/api/client";
import type { Message } from "@valet/api/wire";
import { StepLogs } from "./step-logs";
vi.mock("~/api/client", () => ({ api: { listMessages: vi.fn() } }));
vi.mock("~/components/session/message-item", () => ({ MessageItem: ({ message }: { message: Message }) => <p>{message.content}</p> }));
const list = vi.mocked(api.listMessages);
function message(id: string, queueItemId: string): Message {
  return { id, queueItemId, sessionId: "s", threadId: "t", role: "assistant", content: id, parts: [], createdAt: 1 };
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><StepLogs sessionId="s" threadId="t" queueItemId="q-step" active={false} /></QueryClientProvider>);
}
beforeEach(() => list.mockReset());
describe("StepLogs", () => {
  it("loads the exact submission and excludes unrelated legacy-server messages", async () => {
    list.mockResolvedValue({ messages: [message("step result", "q-step"), message("unrelated", "q-other")], hasMore: false });
    mount();
    expect(await screen.findByText("step result")).toBeTruthy();
    expect(screen.queryByText("unrelated")).toBeNull();
    expect(list).toHaveBeenCalledWith("s", { threadId: "t", queueItemId: "q-step", limit: 200 });
  });
  it("fetches the final reply when checkpoint polling observes completion", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    list.mockResolvedValueOnce({ messages: [message("working", "q-step")], hasMore: false });
    const view = (active: boolean) => <QueryClientProvider client={client}><StepLogs sessionId="s" threadId="t" queueItemId="q-step" active={active} /></QueryClientProvider>;
    const { rerender } = render(view(true));
    expect(await screen.findByText("working")).toBeTruthy();
    list.mockResolvedValue({ messages: [message("final reply", "q-step")], hasMore: false });
    rerender(view(false));
    expect(await screen.findByText("final reply")).toBeTruthy();
  });


  it("offers retry on failure and recovers", async () => {
    list.mockRejectedValueOnce(new Error("403"));
    mount();
    expect(await screen.findByRole("alert")).toBeTruthy();
    list.mockResolvedValue({ messages: [], hasMore: false });
    fireEvent.click(screen.getByText("Retry"));
    expect(await screen.findByText(/No messages recorded/)).toBeTruthy();
  });
  it("loads an earlier bounded tail for the same attempt", async () => {
    list.mockResolvedValue({ messages: [message("result", "q-step")], hasMore: true });
    mount();
    fireEvent.click(await screen.findByText("Load earlier logs"));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith("s", { threadId: "t", queueItemId: "q-step", limit: 400 }));
  });
});
