import { describe, expect, it, vi } from "vitest";
import { BrowserInputQueue } from "./input-queue";
import type { BrowserHumanInput } from "@valet/shared";

describe("ordered browser input", () => {
  it("coalesces pending pointer moves while preserving down/up order", async () => {
    let finish: (() => void) | undefined;
    const calls: BrowserHumanInput[] = [];
    const send = vi.fn(async (input: BrowserHumanInput) => {
      calls.push(input);
      if (calls.length === 1)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
    });
    const queue = new BrowserInputQueue(send, () => {});
    queue.add({ type: "pointer", phase: "down", x: 1, y: 1 });
    queue.add({ type: "pointer", phase: "move", x: 2, y: 2 });
    queue.add({ type: "pointer", phase: "move", x: 3, y: 3 });
    queue.add({ type: "pointer", phase: "up", x: 4, y: 4 });
    expect(send).toHaveBeenCalledTimes(1);
    finish?.();
    await vi.waitFor(() =>
      expect(calls).toEqual([
        { type: "pointer", phase: "down", x: 1, y: 1 },
        { type: "pointer", phase: "move", x: 3, y: 3 },
        { type: "pointer", phase: "up", x: 4, y: 4 },
      ]),
    );
  });

  it("ignores an old request failure after its page queue is disposed", async () => {
    let reject: ((error: Error) => void) | undefined;
    const failure = vi.fn();
    const request = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    const send = vi.fn(() => request);
    const queue = new BrowserInputQueue(send, failure);
    queue.add({ type: "key", key: "x" });
    queue.add({ type: "key", key: "y" });
    queue.dispose();
    reject?.(new Error("The previous document changed."));
    await request.catch(() => {});
    expect(failure).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it("stops queued input after a stale-reference error", async () => {
    const fail = vi.fn();
    const send = vi
      .fn()
      .mockRejectedValue(
        new Error("The document changed. Refresh browser status."),
      );
    const queue = new BrowserInputQueue(send, fail);
    queue.add({ type: "text", text: "hello" });
    queue.add({ type: "key", key: "Enter" });
    await vi.waitFor(() => expect(fail).toHaveBeenCalledOnce());
    expect(send).toHaveBeenCalledOnce();
  });
});
