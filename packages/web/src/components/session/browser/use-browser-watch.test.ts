// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Message } from "@valet/api/wire";
import { useBrowserWatch } from "./use-browser-watch";

function message(
  toolName = "browser.execute",
  status: "running" | "completed" = "running",
  args?: unknown,
): Message {
  return {
    id: "m",
    sessionId: "s",
    threadId: "t",
    role: "assistant",
    content: "",
    createdAt: 1,
    parts: [{ kind: "tool_call", callId: "c", toolName, status, args }],
  };
}
const props = {
  sessionId: "s",
  threadId: "t",
  messages: [message()],
  agentBusy: true,
};

describe("browser watch lifecycle", () => {
  it.each([
    "browser.execute",
    "browser__execute",
    "tool_browser_execute",
    "tool_browser.execute",
  ])("opens for %s and stays open after completion", (name) => {
    const hook = renderHook(useBrowserWatch, {
      initialProps: { ...props, messages: [message(name)] },
    });
    expect(hook.result.current.mode).toBe("open");
    hook.rerender({
      ...props,
      agentBusy: false,
      messages: [message(name, "completed")],
    });
    expect(hook.result.current.mode).toBe("open");
    expect(hook.result.current.working).toBe(false);
  });
  it("recognizes indirect calls but excludes documentation, history, other threads, and idle stale calls", () => {
    for (const next of [
      { ...props, messages: [message("browser.describe")] },
      { ...props, messages: [message("browser.execute", "completed")] },
      { ...props, threadId: "other" },
      { ...props, sessionId: "other" },
      { ...props, agentBusy: false },
    ]) {
      const hook = renderHook(useBrowserWatch, { initialProps: next });
      expect(hook.result.current.mode).toBe("auto");
      hook.unmount();
    }
    const hook = renderHook(useBrowserWatch, {
      initialProps: {
        ...props,
        messages: [
          message("call_tool", "running", { tool_id: "browser.execute" }),
        ],
      },
    });
    expect(hook.result.current.mode).toBe("open");
  });
  it("keeps dismissal and minimization until restored, separately for each session and thread", () => {
    const hook = renderHook(useBrowserWatch, { initialProps: props });
    act(() => hook.result.current.close());
    hook.rerender({ ...props, messages: [message()] });
    expect(hook.result.current.mode).toBe("closed");
    hook.rerender({ ...props, threadId: "other" });
    expect(hook.result.current.mode).toBe("auto");
    act(() => hook.result.current.open());
    act(() => hook.result.current.minimize());
    expect(hook.result.current.mode).toBe("minimized");
    hook.rerender(props);
    expect(hook.result.current.mode).toBe("closed");
    act(() => hook.result.current.open());
    expect(hook.result.current.mode).toBe("open");
    hook.rerender({ ...props, sessionId: "other" });
    expect(hook.result.current.mode).toBe("auto");
  });
});
