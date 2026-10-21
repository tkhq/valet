// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { StreamMessage } from "~/stores/stream";
import { recapSinceLabel, ThreadRecapDock, useThreadRecap, type ThreadRecapView } from "./thread-recap";
import { MessageList } from "./message-list";

const markMutate = vi.fn();
const getThreadRecap = vi.fn();

vi.mock("~/api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/api/queries")>()),
  useMarkThreadsRead: () => ({ mutate: markMutate }),
}));
vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return { ...actual, api: { ...actual.api, getThreadRecap: (...args: unknown[]) => getThreadRecap(...args) } };
});
vi.mock("./message-item", () => ({
  MessageItem: ({ message }: { message: StreamMessage }) => <div data-testid="message-item">{message.id}</div>,
}));

const reader = { id: "u-reader", name: "Reader" };
const mate = { id: "u-mate", name: "Mate" };

function msg(id: string, createdAt: number, role: "user" | "assistant", content: string, author?: StreamMessage["author"]): StreamMessage {
  return { id, sessionId: "s1", threadId: "t1", role, content, parts: [], createdAt, ...(author ? { author } : {}) };
}

const messages = [
  msg("m1", 1_000, "user", "pull the report", reader),
  msg("m2", 2_000, "assistant", "Done."),
  msg("m3", 10_000, "user", "fill out the questionnaire", mate),
  msg("m4", 11_000, "assistant", "Drafted 38 answers."),
  msg("m5", 12_000, "user", "send it", mate),
  msg("m6", 13_000, "assistant", "Sent."),
];

let visibility: DocumentVisibilityState = "visible";
function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  markMutate.mockReset();
  getThreadRecap.mockReset().mockResolvedValue({ recap: { mode: "away", points: [{ text: "Decide on the pen-test summary.", forReader: true }, { text: "Mate sent the draft." }] } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useThreadRecap", () => {
  it("anchors at the first new message, asks for the recap with the last read time, and marks the thread read", async () => {
    const thread = { id: "t1", sessionId: "s1", readAt: 5_000 };
    const { result } = renderHook(() => useThreadRecap({ threadId: "t1", thread, messages, viewerId: reader.id }), { wrapper });
    expect(result.current).toMatchObject({ anchorId: "m3", mode: "away" });
    expect(result.current?.divider).toMatch(/^New since .+ · Mate$/);
    await waitFor(() => expect(result.current?.points).toHaveLength(2));
    expect(getThreadRecap).toHaveBeenCalledWith("t1", 5_000);
    expect(markMutate).toHaveBeenCalledWith({ threadIds: ["t1"] });
  });

  it("asks for a new recap when another person writes, not when Valet does", async () => {
    const thread = { id: "t1", sessionId: "s1", readAt: 5_000 };
    const { rerender } = renderHook(({ list }) => useThreadRecap({ threadId: "t1", thread, messages: list, viewerId: reader.id }),
      { wrapper, initialProps: { list: messages } });
    await waitFor(() => expect(getThreadRecap).toHaveBeenCalledTimes(1));
    rerender({ list: [...messages, msg("m7", 14_000, "assistant", "Still here.")] });
    rerender({ list: [...messages, msg("m7", 14_000, "assistant", "Still here."), msg("m8", 15_000, "user", "quote due Monday", mate)] });
    await waitFor(() => expect(getThreadRecap).toHaveBeenCalledTimes(2));
  });

  it("keeps the visit's read time after the thread is marked read", () => {
    const { result, rerender } = renderHook(({ readAt }) => useThreadRecap({ threadId: "t1", thread: { id: "t1", sessionId: "s1", readAt }, messages, viewerId: reader.id }),
      { wrapper, initialProps: { readAt: 5_000 } });
    rerender({ readAt: 20_000 });
    expect(result.current?.anchorId).toBe("m3");
  });

  it("shows nothing when only the reader and Valet wrote since the last read", () => {
    const { result } = renderHook(() => useThreadRecap({ threadId: "t1", thread: { id: "t1", sessionId: "s1", readAt: 14_000 }, messages, viewerId: reader.id }), { wrapper });
    expect(result.current).toBeUndefined();
    expect(getThreadRecap).not.toHaveBeenCalled();
  });

  it("does not mark a thread read while the page is hidden", () => {
    visibility = "hidden";
    renderHook(() => useThreadRecap({ threadId: "t1", thread: { id: "t1", sessionId: "s1", readAt: 5_000 }, messages, viewerId: reader.id }), { wrapper });
    expect(markMutate).not.toHaveBeenCalled();
    act(() => setVisibility("visible"));
    expect(markMutate).toHaveBeenCalledWith({ threadIds: ["t1"] });
  });

  it("starts a new visit when another person wrote while the tab was hidden", () => {
    const thread = { id: "t1", sessionId: "s1", readAt: 14_000 };
    const { result, rerender } = renderHook(({ list }) => useThreadRecap({ threadId: "t1", thread, messages: list, viewerId: reader.id }),
      { wrapper, initialProps: { list: messages } });
    expect(result.current).toBeUndefined();
    vi.spyOn(Date, "now").mockReturnValue(15_000);
    act(() => setVisibility("hidden"));
    rerender({ list: [...messages, msg("m7", 16_000, "user", "ask Reader", mate)] });
    act(() => setVisibility("visible"));
    expect(result.current).toMatchObject({ anchorId: "m7", mode: "away" });
  });
});

describe("MessageList new-since line", () => {
  it("renders the line before the anchor message", () => {
    render(<MessageList messages={messages} threadId="t1" newSince={{ anchorId: "m3", label: "New since 9:00 AM · Mate" }} />);
    const line = screen.getByTestId("new-since-divider");
    expect(line.textContent).toBe("New since 9:00 AM · Mate");
    expect(line.compareDocumentPosition(screen.getByText("m3")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.compareDocumentPosition(screen.getByText("m2")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });
});

describe("ThreadRecapDock", () => {
  const recap: ThreadRecapView = { key: "t1:5000:0", anchorId: "m3", mode: "away", people: "Mate", divider: "New since 9:00 AM · Mate",
    points: [{ text: "Decide on the pen-test summary.", forReader: true }, { text: "Mate sent the draft." }] };

  it("shows the recap above the composer and closes for this visit", () => {
    const { rerender } = render(<ThreadRecapDock recap={recap} />);
    const card = screen.getByTestId("thread-recap");
    expect(card.textContent).toContain("While you were away · Mate");
    expect(card.textContent).toContain("Waiting on you: Decide on the pen-test summary.");
    fireEvent.click(screen.getByRole("button", { name: "Close recap" }));
    expect(screen.queryByTestId("thread-recap")).toBeNull();
    rerender(<ThreadRecapDock recap={{ ...recap, key: "t1:16000:1" }} />);
    expect(screen.getByTestId("thread-recap")).toBeTruthy();
  });

  it("shows the heading only beside a waiting question card, and opens on click", () => {
    render(<ThreadRecapDock recap={recap} collapsed />);
    const toggle = screen.getByRole("button", { name: /While you were away · Mate/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Mate sent the draft.")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Mate sent the draft.")).toBeTruthy();
  });

  it("renders nothing while the recap loads", () => {
    render(<ThreadRecapDock recap={{ ...recap, points: undefined }} />);
    expect(screen.queryByTestId("thread-recap")).toBeNull();
  });
});

describe("recapSinceLabel", () => {
  it("reads a time today, yesterday, a weekday, then a date", () => {
    const now = new Date(2026, 9, 21, 15, 0).getTime();
    expect(recapSinceLabel(new Date(2026, 9, 21, 9, 5).getTime(), now)).toMatch(/9:05/);
    expect(recapSinceLabel(new Date(2026, 9, 20, 9, 5).getTime(), now)).toBe("yesterday");
    expect(recapSinceLabel(new Date(2026, 9, 17, 9, 5).getTime(), now)).toBe("Saturday");
    expect(recapSinceLabel(new Date(2026, 9, 3, 9, 5).getTime(), now)).toMatch(/Oct 3/);
  });
});
