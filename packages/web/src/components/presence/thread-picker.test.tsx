// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ListThreadsResponse, ThreadSummary } from "@valet/api/wire";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listThreads = vi.fn<(sessionId: string, opts?: { q?: string }) => Promise<ListThreadsResponse>>();
vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return { ...actual, api: { ...actual.api, listThreads: (sessionId: string, opts?: { q?: string }) => listThreads(sessionId, opts) } };
});
const ownerConversation = vi.fn();
vi.mock("~/hooks/use-workspace-conversation", () => ({
  useOwnerConversation: (workspace: string | undefined) => ownerConversation(workspace),
}));

import { ThreadPicker } from "./thread-picker";

function thread(id: string, title: string | undefined, lastUserActivityAt: number, archivedAt?: number): ThreadSummary {
  return { id, sessionId: "sess-1", title, createdAt: 1, lastUserActivityAt, ...(archivedAt !== undefined ? { archivedAt } : {}) };
}

function renderPicker(onPick = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ThreadPicker workspace="user" onPick={onPick} /></QueryClientProvider>);
  return onPick;
}

beforeEach(() => {
  listThreads.mockReset();
  ownerConversation.mockReset();
  ownerConversation.mockReturnValue({ data: { sessionId: "sess-1" }, isLoading: false, error: null });
  listThreads.mockResolvedValue({
    threads: [
      thread("t-old", "Deploy notes", 1_000),
      thread("t-new", "Incident review", 5_000),
      thread("t-archived", "Old incident", 9_000, 9_500),
      thread("t-untitled", undefined, 3_000),
    ],
  });
});

describe("ThreadPicker", () => {
  it("lists open threads newest first from the workspace's assistant", async () => {
    renderPicker();
    await screen.findByRole("option", { name: /Incident review/ });
    expect(ownerConversation).toHaveBeenCalledWith("user");
    expect(listThreads.mock.calls[0][0]).toBe("sess-1");
    const names = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(names[0]).toContain("Incident review");
    expect(names[1]).toContain("Untitled thread");
    expect(names[2]).toContain("Deploy notes");
    expect(screen.queryByRole("option", { name: /Old incident/ })).toBeNull();
  });

  it("filters by title and emits the picked thread", async () => {
    const onPick = renderPicker();
    await screen.findByRole("option", { name: /Incident review/ });
    fireEvent.change(screen.getByLabelText("Search threads"), { target: { value: "deploy" } });
    expect(screen.queryByRole("option", { name: /Incident review/ })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /Deploy notes/ }));
    expect(onPick).toHaveBeenCalledWith({ mode: "existing", sessionId: "sess-1", threadId: "t-old" }, "Deploy notes");
  });
});
