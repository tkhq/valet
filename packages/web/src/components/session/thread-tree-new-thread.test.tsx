// @vitest-environment jsdom
/**
 * "+ new thread" affordance at the bottom of the thread tree (only rendered
 * on `/chat`, decision 12 sidebar). Verifies the click calls
 * `useCreateThread`'s mutation and navigates to the new thread — the tree's
 * other tests (`thread-tree.test.ts`) cover pure grouping/status logic;
 * this one needs a render since the behavior is a hook call + navigation.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { TooltipProvider } from "~/components/primitives";

const navigate = vi.fn();
const createThreadMutateAsync = vi.fn().mockResolvedValue({
  id: "thread-new",
  title: null,
  createdAt: Date.now(),
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  useSearch: () => ({}),
  useNavigate: () => navigate,
}));

vi.mock("~/api/queries", () => ({
  useThreads: () => ({
    data: { threads: [{ id: "thread-1", title: null, createdAt: Date.now() }] },
    isLoading: false,
    error: null,
  }),
  useCreateThread: () => ({
    mutateAsync: createThreadMutateAsync,
    isPending: false,
  }),
}));

vi.mock("~/api/orchestrator", () => ({
  useOrchestratorInfo: () => ({ data: { sessionId: "orchestrator:user-1" } }),
  useOrchestratorChildren: () => ({ data: { children: [] }, refetch: vi.fn() }),
}));

vi.mock("~/stores/stream", () => ({
  useStreamStore: () => undefined,
}));

import { ThreadTree } from "./thread-tree";

describe("ThreadTree — new thread affordance", () => {
  it("creates a thread and navigates to it", async () => {
    render(
      <TooltipProvider>
        <ThreadTree />
      </TooltipProvider>,
    );

    const button = screen.getByRole("button", { name: /new thread/i });
    await userEvent.click(button);

    expect(createThreadMutateAsync).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.any(Function) }),
    );
    const call = navigate.mock.calls[0][0] as { search: (prev: Record<string, unknown>) => Record<string, unknown> };
    expect(call.search({ thread: "thread-1" })).toEqual({
      thread: "thread-new",
      child: undefined,
    });
  });
});
