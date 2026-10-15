// @vitest-environment jsdom
/**
 * Thread sharing (docs/specs/2026-10-13-thread-sharing-design.md): the
 * owner's Share dialog, and the page a guest sees when they open a shared
 * thread by its link.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ThreadSummary } from "@valet/api/wire";
import { api } from "~/api/client";
import { TooltipProvider } from "~/components/primitives";

// importOriginal keeps the module's other exports real (see vitest.config.ts).
vi.mock("~/api/ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/ws")>();
  return { ...actual, useSessionWebSocket: vi.fn() };
});
vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return { ...actual, useMe: () => ({ data: { id: "guest" }, isLoading: false, error: null }) };
});

import { useSessionWebSocket } from "~/api/ws";
import { ShareThreadDialog } from "./share-thread-dialog";
import { SharedThreadView } from "./shared-thread-view";

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><TooltipProvider>{node}</TooltipProvider></QueryClientProvider>);
}

const thread: ThreadSummary = { id: "thread-1", sessionId: "sess-1", createdAt: 1, lastUserActivityAt: 1 };

afterEach(() => vi.restoreAllMocks());

describe("ShareThreadDialog", () => {
  it("saves the chosen mode and states that replies use the owner's accounts", async () => {
    const patch = vi.spyOn(api, "patchThread").mockResolvedValue({ ...thread, share: "reply" });
    wrap(<ShareThreadDialog sessionId="sess-1" threadId="thread-1" share={undefined} open onOpenChange={() => {}} />);

    expect(screen.getByRole("status").textContent).toBe("Only you can open this thread.");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Copy link" }).disabled).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "View + reply" }));
    expect(patch).toHaveBeenCalledWith("thread-1", { share: "reply" });
    expect(screen.getByRole("status").textContent).toContain(
      "People who reply can use your connected accounts and tools, with your permission settings.",
    );
  });

  it("turns a share off", async () => {
    const patch = vi.spyOn(api, "patchThread").mockResolvedValue(thread);
    wrap(<ShareThreadDialog sessionId="sess-1" threadId="thread-1" share="view" open onOpenChange={() => {}} />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Copy link" }).disabled).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Off" }));
    expect(patch).toHaveBeenCalledWith("thread-1", { share: "off" });
  });
});

describe("SharedThreadView", () => {
  const address = { id: "thread-1", sessionId: "sess-1", title: "Checkout incident", createdAt: 1, archivedAt: null, share: "view" as const };

  function stubThread() {
    vi.spyOn(api, "listMessages").mockResolvedValue({
      messages: [{ id: "m1", sessionId: "sess-1", threadId: "thread-1", role: "user", content: "Investigate the checkout errors", parts: [], createdAt: 1 }],
      hasMore: false,
    });
    vi.spyOn(api, "listThreadDecisions").mockResolvedValue({ gates: [] });
  }

  it("shows a view-only guest the thread live, with no way to send", async () => {
    stubThread();
    wrap(<SharedThreadView address={address} guest={{ mode: "view", ownerName: "Ops Lead" }} />);

    await screen.findByText("Investigate the checkout errors");
    screen.getByText("Shared by Ops Lead");
    screen.getByText("View only");
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    screen.getByText("You can watch this thread. To send messages, ask Ops Lead to allow replies.");
    // The stream opens for this one thread, by its address.
    expect(vi.mocked(useSessionWebSocket)).toHaveBeenCalledWith("sess-1", "thread-1");
  });

  it("gives a reply guest a composer without attachments", async () => {
    stubThread();
    wrap(<SharedThreadView address={{ ...address, share: "reply" }} guest={{ mode: "reply", ownerName: "Ops Lead" }} />);

    await screen.findByRole("textbox", { name: "Message" });
    expect(screen.queryByRole("button", { name: /Attach/ })).toBeNull();
    screen.getByText("View + reply");
  });

  it("renders no rating controls and never asks for the session's ratings", async () => {
    const ratings = vi.spyOn(api, "getSessionRatings").mockResolvedValue({ session: null, entries: {} });
    vi.spyOn(api, "listMessages").mockResolvedValue({
      messages: [
        { id: "m1", sessionId: "sess-1", threadId: "thread-1", role: "user", content: "Investigate the checkout errors", parts: [], createdAt: 1 },
        { id: "m2", sessionId: "sess-1", threadId: "thread-1", role: "assistant", content: "The payment provider times out.", parts: [], createdAt: 2 },
      ],
      hasMore: false,
    });
    vi.spyOn(api, "listThreadDecisions").mockResolvedValue({ gates: [] });
    wrap(<SharedThreadView address={address} guest={{ mode: "view", ownerName: "Ops Lead" }} />);

    await screen.findByText("The payment provider times out.");
    expect(screen.queryByRole("button", { name: "Good reply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Bad reply" })).toBeNull();
    expect(ratings).not.toHaveBeenCalled();
  });

  it("tells a guest when the thread is no longer shared", async () => {
    vi.spyOn(api, "listMessages").mockRejectedValue(new Error("Thread not found."));
    vi.spyOn(api, "listThreadDecisions").mockResolvedValue({ gates: [] });
    wrap(<SharedThreadView address={address} guest={{ mode: "view", ownerName: "Ops Lead" }} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Ask Ops Lead to share it again."));
  });
});
