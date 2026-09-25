import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi, fetchBrowserFrame, pollBrowserFrames } from "./browser";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("browser frame transport", () => {
  it("requests a durable screenshot from the selected runtime and tab", async () => {
    const artifact = {
      id: "image",
      sessionId: "session/1",
      documentId: "document",
      filename: "page.png",
    };
    const fetcher = vi.fn().mockResolvedValue(Response.json(artifact));
    vi.stubGlobal("fetch", fetcher);
    expect(
      await browserApi.capture("session/1", {
        runtimeId: "runtime",
        tabId: "tab",
      }),
    ).toEqual(artifact);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/sessions/session%2F1/browser/evidence",
    );
    expect(fetcher.mock.calls[0]?.[1].method).toBe("POST");
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body)).toEqual({
      runtimeId: "runtime",
      tabId: "tab",
    });
  });

  it("carries the view ticket and validates the frame identity and CSS viewport", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(new Blob(["jpeg"], { type: "image/jpeg" }), {
        headers: {
          "content-type": "image/jpeg",
          "x-browser-runtime-id": "runtime",
          "x-browser-document-id": "doc",
          "x-browser-viewport-width": "1280",
          "x-browser-viewport-height": "720",
          "x-browser-agent-cursor": JSON.stringify({ x: 12, y: 24, kind: "click", sequence: 1, ageMs: 40 }),
        },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const result = await fetchBrowserFrame(
      "session/1",
      "runtime",
      "tab",
      "ticket",
      new AbortController().signal,
    );
    expect(result.documentId).toBe("doc");
    expect(result.agentCursor).toEqual({ x: 12, y: 24, kind: "click", sequence: 1, ageMs: 40 });
    expect(result.viewport).toEqual({ width: 1280, height: 720 });
    expect(fetcher.mock.calls[0]?.[0]).toContain("session%2F1/browser/frame?");
    expect(fetcher.mock.calls[0]?.[1].headers).toEqual({
      "x-browser-ticket": "ticket",
    });
  });

  it("rejects stale or unidentifiable images before they can receive input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("jpeg", {
          headers: {
            "content-type": "image/jpeg",
            "x-browser-runtime-id": "old-runtime",
          },
        }),
      ),
    );
    await expect(
      fetchBrowserFrame(
        "session",
        "runtime",
        "tab",
        "ticket",
        new AbortController().signal,
      ),
    ).rejects.toThrow(/changed|identity/);
  });

  it.each(['{"x":', JSON.stringify({ x: 9999, y: 2, kind: "click", sequence: 1, ageMs: 20 }), "x".repeat(1025)])(
    "ignores malformed optional activity metadata without losing the image: %s", async (header) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("jpeg", { headers: {
        "content-type": "image/jpeg", "x-browser-runtime-id": "runtime", "x-browser-document-id": "doc",
        "x-browser-viewport-width": "1280", "x-browser-viewport-height": "720", "x-browser-agent-cursor": header,
      } })));
      const frame = await fetchBrowserFrame("session", "runtime", "tab", "ticket", new AbortController().signal);
      expect(frame.agentCursor).toBeUndefined();
      expect(await frame.blob.text()).toBe("jpeg");
    },
  );

  it("cancels an oversized stream before consuming the remaining body", async () => {
    const cancelled = vi.fn();
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks++ < 3) controller.enqueue(new Uint8Array(3 * 1024 * 1024));
        else controller.close();
      },
      cancel: cancelled,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          headers: {
            "content-type": "image/jpeg",
            "x-browser-runtime-id": "runtime",
            "x-browser-document-id": "doc",
            "x-browser-viewport-width": "1280",
            "x-browser-viewport-height": "720",
          },
        }),
      ),
    );
    await expect(
      fetchBrowserFrame(
        "session",
        "runtime",
        "tab",
        "ticket",
        new AbortController().signal,
      ),
    ).rejects.toThrow(/size limit/);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("never overlaps frame requests and aborts without publishing late frames", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    let finish: ((value: number) => void) | undefined;
    const load = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    const publish = vi.fn();
    const task = pollBrowserFrames(load, publish, abort.signal);
    await vi.advanceTimersByTimeAsync(1000);
    expect(load).toHaveBeenCalledTimes(1);
    finish?.(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    abort.abort();
    finish?.(2);
    await task;
    expect(publish.mock.calls).toEqual([[1]]);
  });
});


it("starts preview frames at a bounded 100 ms cadence without adding capture time", async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  const starts: number[] = [];
  const task = pollBrowserFrames(async () => {
    starts.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 40));
    return 1;
  }, () => {}, abort.signal);
  await vi.advanceTimersByTimeAsync(240);
  expect(starts.map((time) => time - starts[0])).toEqual([0, 100, 200]);
  abort.abort();
  await task;
});
