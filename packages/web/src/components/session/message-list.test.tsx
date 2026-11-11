// @vitest-environment jsdom
/**
 * MessageList routing (decision 3): a message with `.signal` set must be
 * handed to `SignalCard`, never `MessageItem` — that's the mechanism that
 * keeps a `child.settled` notification from rendering as a fake "You"
 * bubble. Child renderers are stubbed so this test only covers the
 * routing decision, not their internals (covered by their own tests).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { StreamMessage } from "~/stores/stream";
import { MessageList } from "./message-list";
import { isContinuation } from "./transcript-plan";

vi.mock("./message-item", () => ({
  MessageItem: ({ message }: { message: StreamMessage }) => (
    <div data-testid="message-item">{message.id}</div>
  ),
}));
vi.mock("./signal-card", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./signal-card")>()),
  SignalCard: ({ message }: { message: StreamMessage }) => (
    <div data-testid="signal-card">{message.id}</div>
  ),
}));

function msg(overrides: Partial<StreamMessage> = {}): StreamMessage {
  return {
    id: "m1",
    sessionId: "s1",
    threadId: "t1",
    role: "assistant",
    content: "hello",
    parts: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("MessageList signal routing", () => {
  it("renders a plain message via MessageItem", () => {
    render(<MessageList messages={[msg({ id: "plain" })]} threadId="t1" />);
    expect(screen.getByTestId("message-item").textContent).toBe("plain");
    expect(screen.queryByTestId("signal-card")).toBeNull();
  });

  it("renders a signal-bearing message via SignalCard, not MessageItem", () => {
    render(
      <MessageList
        messages={[msg({ id: "sig", signal: { signalType: "child.settled" } })]}
        threadId="t1"
      />,
    );
    expect(screen.getByTestId("signal-card").textContent).toBe("sig");
    expect(screen.queryByTestId("message-item")).toBeNull();
  });

  it("routes each message independently in a mixed list", () => {
    render(
      <MessageList
        messages={[
          msg({ id: "plain-1" }),
          msg({ id: "sig-1", signal: { signalType: "reminder.due" } }),
          msg({ id: "plain-2" }),
        ]}
        threadId="t1"
      />,
    );
    expect(screen.getAllByTestId("message-item").map((el) => el.textContent)).toEqual([
      "plain-1",
      "plain-2",
    ]);
    expect(screen.getByTestId("signal-card").textContent).toBe("sig-1");
  });

  it("removes pending queue items from the transcript until they dispatch", () => {
    const messages = [
      msg({ id: "queued", role: "user", queueItemId: "q-1" }),
      msg({ id: "settled", role: "user", queueItemId: "q-2" }),
    ];
    const { rerender } = render(
      <MessageList messages={messages} threadId="t1" pendingIds={["q-1"]} />,
    );

    expect(screen.getAllByTestId("message-item").map((el) => el.textContent)).toEqual(["settled"]);

    rerender(<MessageList messages={messages} threadId="t1" pendingIds={[]} />);
    expect(screen.getAllByTestId("message-item").map((el) => el.textContent)).toEqual([
      "queued",
      "settled",
    ]);
  });
});

/**
 * V1 port #12 — the jump-to-bottom control. Stick-to-bottom was ported with
 * the same 80px threshold, but a reader who scrolled up had no way back
 * except dragging the bar to the end of a long transcript.
 *
 * jsdom does no layout, so `scrollHeight`/`clientHeight` are 0 unless set.
 * These tests define them on the scroller and fire `scroll` by hand, which
 * is what the component actually reads.
 */
describe("MessageList jump-to-bottom", () => {
  /** The scroll container: the only element with `overflow-y-auto`. */
  function scroller(container: HTMLElement): HTMLElement {
    const el = container.querySelector(".overflow-y-auto");
    if (!(el instanceof HTMLElement)) throw new Error("no scroll container rendered");
    return el;
  }

  /** Places the scroller `distanceFromBottom` px above the end. */
  function scrollTo(el: HTMLElement, distanceFromBottom: number): void {
    Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
    fireEvent.wheel(el, { deltaY: -distanceFromBottom });
    el.scrollTop = 1000 - 400 - distanceFromBottom;
    fireEvent.scroll(el);
  }

  it("stays hidden while the list is at the bottom", () => {
    const { container } = render(<MessageList messages={[msg()]} threadId="t1" />);
    expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();

    // Inside the 80px "near bottom" band — still no button.
    scrollTo(scroller(container), 40);
    expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();
  });

  it("appears once the reader scrolls past the threshold", () => {
    const { container } = render(<MessageList messages={[msg()]} threadId="t1" />);
    scrollTo(scroller(container), 300);
    expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeTruthy();
  });

  it("returns to the bottom and hides itself on click", () => {
    const { container } = render(<MessageList messages={[msg()]} threadId="t1" />);
    const el = scroller(container);
    scrollTo(el, 300);

    fireEvent.click(screen.getByRole("button", { name: "Jump to latest message" }));

    expect(el.scrollTop).toBe(1000);
    // A programmatic scroll on a list already at the end fires no scroll
    // event, so the click itself has to clear the button.
    expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();
  });

  describe("viewport resize", () => {
    let fire: () => void;
    beforeEach(() => {
      vi.stubGlobal("ResizeObserver", class {
        constructor(cb: (entries: []) => void) { fire = () => cb([]); }
        observe() {}
        disconnect() {}
      });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("re-pins to the bottom when pinned and the viewport shrinks", () => {
      const { container } = render(<MessageList messages={[msg()]} threadId="t1" />);
      const el = scroller(container);
      scrollTo(el, 0);
      Object.defineProperty(el, "clientHeight", { value: 200, configurable: true });
      act(() => fire());
      expect(el.scrollTop).toBe(1000);
      expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();
    });

    it("shows Latest, without moving the scroll, when scrolled away and the viewport shrinks", () => {
      const { container } = render(<MessageList messages={[msg()]} threadId="t1" />);
      const el = scroller(container);
      scrollTo(el, 300);
      const top = el.scrollTop;
      Object.defineProperty(el, "clientHeight", { value: 200, configurable: true });
      act(() => fire());
      expect(el.scrollTop).toBe(top);
      expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeTruthy();
    });

    it("does not pin when growing brings an unpinned reader near the end", () => {
      const { container, rerender } = render(<MessageList messages={[msg()]} threadId="t1" />);
      const el = scroller(container);
      scrollTo(el, 300);
      Object.defineProperty(el, "clientHeight", { value: 650, configurable: true });
      act(() => fire());
      // Unpinned stays unpinned inside the band, so Latest stays up.
      expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeTruthy();
      rerender(<MessageList messages={[msg(), msg({ id: "m2" })]} threadId="t1" />);
      expect(el.scrollTop).toBe(300);
      Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
      act(() => fire());
      expect(el.scrollTop).toBe(300);
      expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeTruthy();
    });
  });

  describe("viewport resize with scroll anchoring", () => {
    let fire: (entries?: { target: Element; contentRect: { height: number } }[]) => void;
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["performance"] });
      vi.stubGlobal("ResizeObserver", class {
        constructor(cb: typeof fire) { fire = (entries = []) => cb(entries); }
        observe() {}
        disconnect() {}
      });
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

    it("stays pinned through collapse then expand when the scroll event precedes the observer", () => {
      const { container, rerender } = render(<MessageList messages={[msg()]} threadId="t1" />);
      const el = scroller(container);
      Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
      act(() => fire()); // the observer's initial report
      vi.advanceTimersByTime(1000); // the adjustments below are not reader input
      el.scrollTop = 550; // already within the near-bottom threshold before resize
      fireEvent.scroll(el);
      expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();

      // Collapse: the viewport grows 250px and anchoring clamps to the end.
      // Chrome fires scroll, then the observer.
      Object.defineProperty(el, "clientHeight", { value: 650, configurable: true });
      el.scrollTop = 350;
      fireEvent.scroll(el);
      act(() => fire());
      expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();

      // Expand: the viewport shrinks, anchoring restores the old offset and
      // fires scroll with the shrunken height before the observer runs.
      Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
      el.scrollTop = 300;
      fireEvent.scroll(el);
      act(() => fire());
      expect(el.scrollTop).toBe(1000);
      expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();

      // Still following: a new message lands at the end.
      Object.defineProperty(el, "scrollHeight", { value: 1100, configurable: true });
      rerender(<MessageList messages={[msg(), msg({ id: "m2" })]} threadId="t1" />);
      expect(el.scrollTop).toBe(1100);
    });

    it("unpins a 400px scroll and viewport growth in the same task", () => {
      const { container, rerender } = render(<MessageList messages={[msg()]} threadId="t1" />);
      const el = scroller(container);
      Object.defineProperty(el, "scrollHeight", { value: 1600, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
      act(() => fire());
      el.scrollTop = 800; // 400px up from the old bottom
      Object.defineProperty(el, "clientHeight", { value: 500, configurable: true });
      fireEvent.scroll(el);
      act(() => fire());
      expect(el.scrollTop).toBe(800);
      rerender(<MessageList messages={[msg(), msg({ id: "m2" })]} threadId="t1" />);
      expect(el.scrollTop).toBe(800);
      expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeTruthy();
    });

    it("unpins a programmatic Reveal or focus scroll before the next message", () => {
      const { container, rerender } = render(<MessageList messages={[msg()]} threadId="t1" />);
      const el = scroller(container);
      Object.defineProperty(el, "scrollHeight", { value: 1600, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
      act(() => fire());
      el.scrollTop = 400; // scrollIntoView/focus does not produce wheel input
      fireEvent.scroll(el);
      rerender(<MessageList messages={[msg(), msg({ id: "m2" })]} threadId="t1" />);
      expect(el.scrollTop).toBe(400);
      expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeTruthy();
    });

    it.each(["End", "scroll"])("re-pins at the end during streaming via %s", (input) => {
      const { container, rerender } = render(<MessageList messages={[msg()]} threadId="t1" />);
      const el = scroller(container);
      Object.defineProperty(el, "scrollHeight", { value: 1600, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
      act(() => fire());
      fireEvent.wheel(el, { deltaY: -500 });
      el.scrollTop = 400;
      fireEvent.scroll(el);
      if (input === "End") fireEvent.keyDown(el, { key: "End" });
      Object.defineProperty(el, "scrollHeight", { value: 1700, configurable: true });
      el.scrollTop = 1300;
      fireEvent.scroll(el);
      act(() => fire());
      rerender(<MessageList messages={[msg(), msg({ id: "m2" })]} threadId="t1" />);
      expect(el.scrollTop).toBe(1700);
      expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();
    });

    it("keeps the G+35 reader unpinned through a near-bottom scroll and expand", () => {
      const { container, rerender } = render(<MessageList messages={[msg()]} threadId="t1" />);
      const el = scroller(container);
      Object.defineProperty(el, "scrollHeight", { value: 1600, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
      act(() => fire());
      fireEvent.wheel(el, { deltaY: -480 });
      el.scrollTop = 720;
      fireEvent.scroll(el);
      Object.defineProperty(el, "clientHeight", { value: 845, configurable: true });
      act(() => fire());
      fireEvent.scroll(el);
      Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
      act(() => fire());
      // Only the true end resumes following, not the 80px band.
      expect(el.scrollTop).toBe(720);
      rerender(<MessageList messages={[msg(), msg({ id: "m2" })]} threadId="t1" />);
      expect(el.scrollTop).toBe(720);
    });

    it.each(["grow", "shrink", "width", "combined"])("leaves an unpinned reader to browser anchoring on %s", (change) => {
      const { container, rerender } = render(<MessageList messages={[msg()]} threadId="t1" />);
      const el = scroller(container);
      Object.defineProperty(el, "scrollHeight", { value: 1600, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
      act(() => fire());
      fireEvent.wheel(el, { deltaY: -480 });
      el.scrollTop = 400;
      fireEvent.scroll(el);
      if (change !== "width") Object.defineProperty(el, "clientHeight", { value: change === "shrink" ? 300 : 845, configurable: true });
      if (change === "width" || change === "combined") Object.defineProperty(el, "clientWidth", { value: 300, configurable: true });
      const top = 400;
      el.scrollTop = top;
      const write = vi.fn();
      Object.defineProperty(el, "scrollTop", { get: () => top, set: write, configurable: true });
      fireEvent.scroll(el); // before the observer
      act(() => fire());
      fireEvent.scroll(el); // queued layout scroll after the observer
      expect(el.scrollTop).toBe(top);
      rerender(<MessageList messages={[msg(), msg({ id: "m2" })]} threadId="t1" />);
      expect(el.scrollTop).toBe(top);
      Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
      act(() => fire());
      expect(el.scrollTop).toBe(top);
      expect(write).not.toHaveBeenCalled();
    });

    it.each(["before", "after"])("pins a clamped reader with a scroll %s the resize report", (order) => {
      const { container, rerender } = render(<MessageList messages={[msg()]} threadId="t1" />);
      const el = scroller(container);
      Object.defineProperty(el, "scrollHeight", { value: 1600, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
      act(() => fire());
      el.scrollTop = 1080;
      fireEvent.scroll(el);
      Object.defineProperty(el, "clientHeight", { value: 650, configurable: true });
      el.scrollTop = 950;
      if (order === "before") fireEvent.scroll(el);
      act(() => fire());
      if (order === "after") fireEvent.scroll(el);
      expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();
      Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
      act(() => fire());
      expect(el.scrollTop).toBe(1600);
      rerender(<MessageList messages={[msg(), msg({ id: "m2" })]} threadId="t1" />);
      expect(el.scrollTop).toBe(1600);
    });

    it.each([1.5, 2.5])("uses a 2px tolerance for a fractional viewport change of %spx", (delta) => {
      const { container, rerender } = render(<MessageList messages={[msg()]} threadId="t1" />);
      const el = scroller(container);
      Object.defineProperty(el, "scrollHeight", { value: 1600, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
      act(() => fire());
      Object.defineProperty(el, "clientHeight", { value: 400 - delta, configurable: true });
      el.scrollTop = 1120.545; // near the old end, just outside the new threshold
      fireEvent.scroll(el);
      act(() => fire());
      rerender(<MessageList messages={[msg(), msg({ id: "m2" })]} threadId="t1" />);
      expect(el.scrollTop).toBe(delta <= 2 ? 1120.545 : 1600);
    });

    it("ignores a zero-height entry before clientHeight reflects hiding", () => {
      const { container } = render(<MessageList messages={[msg()]} threadId="t1" />);
      const el = scroller(container);
      Object.defineProperty(el, "scrollHeight", { value: 1600, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 429, configurable: true });
      act(() => fire());
      fireEvent.wheel(el, { deltaY: -1000 });
      el.scrollTop = 100;
      fireEvent.scroll(el);
      Object.defineProperty(el, "scrollHeight", { value: 0, configurable: true });
      act(() => fire([{ target: el, contentRect: { height: 0 } }]));
      Object.defineProperty(el, "scrollHeight", { value: 1600, configurable: true });
      act(() => fire());
      expect(el.scrollTop).toBe(100);
      expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeTruthy();
    });

    it("keeps a hidden then shown transcript at the reader's position", () => {
      const { container } = render(<MessageList messages={[msg()]} threadId="t1" />);
      const el = scroller(container);
      Object.defineProperty(el, "scrollHeight", { value: 1600, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 429, configurable: true });
      act(() => fire());
      fireEvent.wheel(el, { deltaY: -1000 });
      el.scrollTop = 100;
      fireEvent.scroll(el);
      expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeTruthy();
      Object.defineProperty(el, "scrollHeight", { value: 0, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 0, configurable: true });
      fireEvent.scroll(el);
      act(() => fire());
      Object.defineProperty(el, "scrollHeight", { value: 1600, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 429, configurable: true });
      el.scrollTop = 100;
      // A scroll can arrive before the restored viewport's observer report.
      fireEvent.scroll(el);
      act(() => fire());
      expect(el.scrollTop).toBe(100);
      expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeTruthy();
      // The height guard must still permit genuine reader scrolls after show.
      fireEvent.wheel(el, { deltaY: 1000 });
      el.scrollTop = 1171;
      fireEvent.scroll(el);
      expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();
    });

    it("keeps a reader who is genuinely scrolled up in place through a resize", () => {
      const { container } = render(<MessageList messages={[msg()]} threadId="t1" />);
      const el = scroller(container);
      Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
      act(() => fire());
      scrollTo(el, 600);
      Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
      fireEvent.scroll(el);
      act(() => fire());
      expect(el.scrollTop).toBe(0);
      expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeTruthy();
    });
  });

  it("never renders on an empty thread", () => {
    render(<MessageList messages={[]} threadId="t1" />);
    expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();
  });
});


describe("MessageList scrolling header", () => {
  function renderThread() {
    const result = render(<MessageList messages={[msg()]} threadId="t1" header={<button>Session controls</button>} />);
    const el = screen.getByTestId("message-list");
    Object.defineProperty(el, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
    return { ...result, el, header: screen.getByTestId("thread-header") };
  }
  function scroll(el: HTMLElement, top: number, user = true) {
    if (user) fireEvent.wheel(el, { deltaY: top - el.scrollTop });
    el.scrollTop = top;
    fireEvent.scroll(el);
  }
  it("accumulates movement, ignores jitter, and reveals on reversal or at the top", () => {
    const { el, header } = renderThread();
    scroll(el, 100, false);
    scroll(el, 106);
    expect(header.dataset.hidden).toBe("false");
    scroll(el, 113);
    expect(header.dataset.hidden).toBe("true");
    scroll(el, 109);
    expect(header.dataset.hidden).toBe("true");
    scroll(el, 100);
    expect(header.dataset.hidden).toBe("false");
    scroll(el, 140);
    scroll(el, -20);
    expect(header.dataset.hidden).toBe("false");
  });
  it("does not hide for programmatic positioning and resets when the thread changes", () => {
    const { el, header, rerender } = renderThread();
    scroll(el, 200, false);
    expect(header.dataset.hidden).toBe("false");
    scroll(el, 240);
    expect(header.dataset.hidden).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest message" }));
    fireEvent.scroll(el);
    expect(header.dataset.hidden).toBe("true");
    rerender(<MessageList messages={[msg({ threadId: "t2" })]} threadId="t2" header={<button>Session controls</button>} />);
    expect(header.dataset.hidden).toBe("false");
  });
  it("opens the next thread at the bottom after the reader leaves the current thread's bottom", () => {
    const { el, rerender } = renderThread();
    scroll(el, 200);
    rerender(<MessageList messages={[msg({ threadId: "t2" })]} threadId="t2" header={<button>Session controls</button>} />);
    expect(el.scrollTop).toBe(2000);
  });
  it("unpins the header after a focused title input is removed", () => {
    const messages = [msg()];
    const result = render(<MessageList messages={messages} threadId="t1" header={<input aria-label="Title" />} />);
    const el = screen.getByTestId("message-list");
    Object.defineProperty(el, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
    act(() => screen.getByRole("textbox", { name: "Title" }).focus());
    scroll(el, 200);
    expect(screen.getByTestId("thread-header").dataset.hidden).toBe("false");
    result.rerender(<MessageList messages={messages} threadId="t1" header={<button>Session controls</button>} />);
    scroll(el, 240);
    expect(screen.getByTestId("thread-header").dataset.hidden).toBe("true");
  });
  it("keeps the header visible when streaming follows the bottom", () => {
    const { el, header, rerender } = renderThread();
    scroll(el, 1600, false);
    Object.defineProperty(el, "scrollHeight", { value: 4000, configurable: true });
    rerender(<MessageList messages={[msg({ content: "More streamed text" })]} threadId="t1" header={<button>Session controls</button>} />);
    fireEvent.scroll(el);
    expect(el.scrollTop).toBe(4000);
    expect(header.dataset.hidden).toBe("false");
  });
  it("preserves header controls when the first message arrives", () => {
    const header = <input aria-label="Title draft" defaultValue="Draft" />;
    const { rerender } = render(<MessageList messages={[]} threadId="t1" header={header} />);
    const input = screen.getByRole("textbox", { name: "Title draft" });
    rerender(<MessageList messages={[msg()]} threadId="t1" header={header} />);
    expect(screen.getByRole("textbox", { name: "Title draft" })).toBe(input);
  });
  it("keeps an empty thread's controls available", () => {
    render(<MessageList messages={[]} threadId="t1" header={<button>Session controls</button>} />);
    expect(screen.getByRole("button", { name: "Session controls" })).toBeTruthy();
  });
});

describe("isContinuation", () => {
  const at = 1_000_000;
  it("joins consecutive assistant messages from one turn under one header", () => {
    const first = msg({ id: "a", model: "luna", createdAt: at });
    expect(isContinuation(msg({ id: "b", model: "luna", createdAt: at + 3_000 }), first)).toBe(true);
  });

  it("starts a new header after a person, a model change, a long gap, or a divider", () => {
    const next = msg({ id: "b", model: "luna", createdAt: at + 3_000 });
    expect(isContinuation(next, undefined)).toBe(false);
    expect(isContinuation(next, msg({ role: "user", createdAt: at }))).toBe(false);
    expect(isContinuation(next, msg({ model: "sol", createdAt: at }))).toBe(false);
    expect(isContinuation(next, msg({ model: "luna", createdAt: at - 10 * 60_000 }))).toBe(false);
    expect(isContinuation(next, msg({ model: "luna", createdAt: at, signal: { signalType: "child.settled" } }))).toBe(false);
    expect(isContinuation(msg({ role: "user", createdAt: at + 1 }), msg({ createdAt: at }))).toBe(false);
  });
});

describe("MessageList loading", () => {
  it("shows placeholder rows, not the empty line, while the transcript loads", () => {
    render(<MessageList messages={[]} loading />);
    expect(screen.getByRole("status", { name: "Loading messages" })).toBeTruthy();
    expect(screen.queryByText(/No messages yet/)).toBeNull();
  });

  it("offers earlier messages above the newest page", () => {
    const onShowEarlier = vi.fn();
    render(<MessageList messages={[msg()]} onShowEarlier={onShowEarlier} />);
    fireEvent.click(screen.getByRole("button", { name: "Show earlier messages" }));
    expect(onShowEarlier).toHaveBeenCalled();
  });
});

/** Streaming growth must not pull a reader who scrolled up back down. */
describe("MessageList follow while streaming", () => {
  function setup() {
    const view = render(<MessageList messages={[msg({ content: "a" })]} threadId="t1" />);
    const el = view.container.querySelector(".overflow-y-auto") as HTMLElement;
    let height = 1000;
    Object.defineProperty(el, "scrollHeight", { get: () => height, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
    el.scrollTop = 600;
    fireEvent.scroll(el); // at the bottom
    const grow = (content: string) => {
      height += 100;
      view.rerender(<MessageList messages={[msg({ content })]} threadId="t1" />);
    };
    // A thinking or tool-arg update: a new messages array, no added height.
    const tick = () => {
      view.rerender(<MessageList messages={[msg({ content: "a" })]} threadId="t1" />);
    };
    return { el, grow, tick };
  }

  it("follows the end while the reader is at the bottom", () => {
    const { el, grow } = setup();
    grow("ab");
    expect(el.scrollTop).toBe(1100);
  });

  it("holds position when the reader scrolled up and the scroll event was reported", () => {
    const { el, grow } = setup();
    el.scrollTop = 200;
    fireEvent.scroll(el);
    grow("ab");
    expect(el.scrollTop).toBe(200);
  });

  it("holds position when a chunk commits before the reader's scroll event", () => {
    const { el, grow } = setup();
    fireEvent.wheel(el, { deltaY: -100 });
    el.scrollTop = 200; // the browser reports this on the next frame
    grow("ab");
    expect(el.scrollTop).toBe(200);
    fireEvent.scroll(el);
    grow("abc");
    expect(el.scrollTop).toBe(200);
  });

  it("stops following on a small upward scroll inside the near-bottom band", () => {
    const { el, grow } = setup();
    fireEvent.wheel(el, { deltaY: -50 });
    el.scrollTop = 550;
    fireEvent.scroll(el);
    grow("ab");
    expect(el.scrollTop).toBe(550);
  });

  it("keeps following when scrollTop drops with no reader input (scroll anchoring)", () => {
    const { el, grow } = setup();
    el.scrollTop = 550; // browser adjustment, no wheel, touch, key or pointer event
    fireEvent.scroll(el);
    grow("ab");
    expect(el.scrollTop).toBe(1100);
  });

  it("resumes following once the reader scrolls back to the bottom", () => {
    const { el, grow } = setup();
    el.scrollTop = 200;
    fireEvent.scroll(el);
    grow("ab");
    el.scrollTop = 700; // the new end: 1100 - 400
    fireEvent.scroll(el);
    grow("abc");
    expect(el.scrollTop).toBe(1200);
  });

  describe("slow gestures while streaming", () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ["performance"] }); });
    afterEach(() => vi.useRealTimers());

    it("stays unpinned through many small upward steps with no-growth commits", () => {
      const { el, tick } = setup();
      for (let i = 0; i < 30; i++) {
        fireEvent.touchMove(el);
        el.scrollTop -= 2;
        tick(); // the commit can run before the frame's scroll event
        fireEvent.scroll(el);
        vi.advanceTimersByTime(16);
        tick();
      }
      expect(el.scrollTop).toBe(600 - 60);
    });

    it("stays unpinned when a no-move scroll event arrives after the input window", () => {
      const { el, grow } = setup();
      fireEvent.touchMove(el);
      el.scrollTop = 540;
      fireEvent.scroll(el);
      vi.advanceTimersByTime(1000);
      fireEvent.scroll(el); // no movement: momentum settling or anchoring
      grow("ab");
      expect(el.scrollTop).toBe(540);
    });

    it.each(["commit first", "scroll first"])("stays unpinned through 1px steps, %s", (order) => {
      const { el, tick } = setup();
      for (let i = 0; i < 30; i++) {
        fireEvent.touchMove(el);
        el.scrollTop -= 1;
        if (order === "commit first") {
          tick();
          fireEvent.scroll(el);
        } else {
          fireEvent.scroll(el);
          tick();
        }
        vi.advanceTimersByTime(16);
        tick();
      }
      expect(el.scrollTop).toBe(570);
    });

    describe("own send", () => {
      const optimistic = (over: Partial<StreamMessage> = {}) =>
        msg({ id: "user-opt-1", role: "user", persistence: "optimistic", ...over });
      const scrolledUp = (viewerId = "u1") => {
        const ui = (messages: StreamMessage[]) => (
          <MessageList messages={messages} threadId="t1" viewerId={viewerId} />
        );
        const view = render(ui([msg()]));
        const el = view.container.querySelector(".overflow-y-auto") as HTMLElement;
        let height = 1000;
        Object.defineProperty(el, "scrollHeight", { get: () => height, configurable: true });
        Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
        el.scrollTop = 600;
        fireEvent.scroll(el);
        fireEvent.wheel(el, { deltaY: -10 });
        el.scrollTop = 590;
        fireEvent.scroll(el);
        vi.advanceTimersByTime(1000); // intent expired
        const send = (messages: StreamMessage[], h = height + 100) => {
          height = h;
          view.rerender(ui(messages));
        };
        return { el, send };
      };

      it("pins on an authorless optimistic row sent from this client", () => {
        const { el, send } = scrolledUp();
        send([msg(), optimistic()]);
        expect(el.scrollTop).toBe(1100);
      });

      it("does not move a reader who scrolled up again when the server row replaces the optimistic one", () => {
        const { el, send } = scrolledUp();
        send([msg(), optimistic()]);
        el.scrollTop = 700; // jsdom does not clamp; a browser would, to scrollHeight - clientHeight
        fireEvent.scroll(el);
        fireEvent.wheel(el, { deltaY: -100 });
        el.scrollTop = 600;
        fireEvent.scroll(el);
        vi.advanceTimersByTime(1000);
        send([msg(), msg({ id: "srv-1", role: "user", author: { id: "u1" } as StreamMessage["author"] })], 1200);
        expect(el.scrollTop).toBe(600);
      });

      it("does not pin for a teammate's message", () => {
        const { el, send } = scrolledUp();
        send([msg(), msg({ id: "srv-2", role: "user", author: { id: "u2" } as StreamMessage["author"] })]);
        expect(el.scrollTop).toBe(590);
      });

      it("does not pin when a queued row reappears", () => {
        const { el, send } = scrolledUp();
        send([msg(), optimistic({ queueItemId: "q1" })]);
        expect(el.scrollTop).toBe(590);
      });
    });

    it("stays pinned when the browser clamps scrollTop fractionally below the computed end", () => {
      const { el, grow } = setup();
      fireEvent.pointerDown(el);
      // Content shrinks: computed end is 500, the real fractional end is 499.3.
      let h = 900;
      Object.defineProperty(el, "scrollHeight", { get: () => h, configurable: true });
      el.scrollTop = 499.3;
      fireEvent.scroll(el);
      h = 1100;
      grow("ab");
      expect(el.scrollTop).toBe(1100);
    });

    it("re-pins when a resize brings an unpinned reader to the end", () => {
      let fireResize: () => void = () => {};
      vi.stubGlobal("ResizeObserver", class {
        constructor(cb: (entries: []) => void) { fireResize = () => cb([]); }
        observe() {}
        disconnect() {}
      });
      const view = render(<MessageList messages={[msg()]} threadId="t1" />);
      const el = view.container.querySelector(".overflow-y-auto") as HTMLElement;
      let height = 1000;
      Object.defineProperty(el, "scrollHeight", { get: () => height, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
      el.scrollTop = 600;
      fireEvent.scroll(el);
      fireEvent.wheel(el, { deltaY: -100 });
      el.scrollTop = 500;
      fireEvent.scroll(el);
      vi.advanceTimersByTime(1000);
      height = 902; // a collapse leaves the reader 2px from the end
      act(() => fireResize());
      height = 1000;
      view.rerender(<MessageList messages={[msg({ content: "ab" })]} threadId="t1" />);
      expect(el.scrollTop).toBe(1000);
      vi.unstubAllGlobals();
    });

    it("stays pinned when a recent-input collapse moves scrollTop less than the viewport change", () => {
      let fireResize: () => void = () => {};
      vi.stubGlobal("ResizeObserver", class {
        constructor(cb: (entries: []) => void) { fireResize = () => cb([]); }
        observe() {}
        disconnect() {}
      });
      const view = render(<MessageList messages={[msg({ content: "a" })]} threadId="t1" />);
      const el = view.container.querySelector(".overflow-y-auto") as HTMLElement;
      let ch = 650;
      Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
      Object.defineProperty(el, "clientHeight", { get: () => ch, configurable: true });
      el.scrollTop = 350;
      fireEvent.scroll(el);
      act(() => fireResize()); // records the 650px viewport
      el.scrollTop = 350; // the follow write above went to the end; put the reader back
      fireEvent.scroll(el);
      fireEvent.touchMove(el);
      ch = 400;
      el.scrollTop = 300;
      fireEvent.scroll(el);
      view.rerender(<MessageList messages={[msg({ content: "ab" })]} threadId="t1" />);
      expect(el.scrollTop).toBe(1000);
      vi.unstubAllGlobals();
    });

    it("unpins a 40px upward scroll in the frame the height changes 400 to 370", () => {
      const view = render(<MessageList messages={[msg({ content: "a" })]} threadId="t1" />);
      const el = view.container.querySelector(".overflow-y-auto") as HTMLElement;
      let ch = 400;
      Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
      Object.defineProperty(el, "clientHeight", { get: () => ch, configurable: true });
      el.scrollTop = 600;
      fireEvent.scroll(el);
      fireEvent.touchMove(el);
      ch = 370;
      el.scrollTop = 560; // 40px up; the new end is 630
      fireEvent.scroll(el);
      view.rerender(<MessageList messages={[msg({ content: "ab" })]} threadId="t1" />);
      expect(el.scrollTop).toBe(560);
    });
  });
});
