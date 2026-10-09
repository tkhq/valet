// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { StreamMessage } from "~/stores/stream";
import { setToolCardDefault } from "~/lib/preferences";
import { TooltipProvider } from "~/components/primitives";
import { MessageItem } from "./message-item";

vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return { ...actual, useSessionRatings: () => ({ data: { entries: {} } }), useRateMessage: () => ({ isPending: false, mutate: vi.fn() }) };
});

const result = {
  text: JSON.stringify({ path: "/workspace/generated-images/fox.png", bytes: 5 }),
  content: [{ type: "text", text: JSON.stringify({ path: "/workspace/generated-images/fox.png", bytes: 5 }) },
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
};
function message(action: string, status: "running" | "completed" | "error", withResult = true): StreamMessage {
  return { id: "m1", sessionId: "s1", threadId: "t1", role: "assistant", content: "", createdAt: 1, completed: status === "completed",
    parts: [{ kind: "tool_call", callId: "c1", toolName: "call_tool", args: { tool_id: `openai.${action}`, params: { prompt: "a red fox" } }, status,
      ...(withResult ? { result } : {}), ...(status === "error" ? { error: "Image request failed. Retry." } : {}) }] };
}
function tree(message: StreamMessage) {
  return <TooltipProvider><MessageItem message={message} /></TooltipProvider>;
}

describe("sandbox-backed image preview", () => {
  beforeEach(() => { localStorage.clear(); });

  it.each(["generate_image", "edit_image"])("%s appears on completion outside a collapsed card and remains after reload", (action) => {
    setToolCardDefault("always-collapsed");
    const view = render(tree(message(action, "running", false)));
    expect(screen.queryByRole("img")).toBeNull();
    view.rerender(tree(message(action, "completed")));
    const image = screen.getByRole("img", { name: "a red fox" });
    expect(image.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
    expect(image.closest("section")).toBeNull();
    const header = screen.getByRole("button", { name: /call tool/i });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("/workspace/generated-images/fox.png")).toBeTruthy();
    fireEvent.click(header);
    expect(screen.getAllByRole("img")).toHaveLength(1);
    fireEvent.click(header);
    expect(screen.getByRole("img")).toBeTruthy();
    view.unmount();
    // Reload supplies a serialized persisted result, not the live object's identity.
    const reloaded: StreamMessage = JSON.parse(JSON.stringify(message(action, "completed")));
    render(tree(reloaded));
    expect(screen.getByRole("img").getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
    expect(screen.getByRole("button", { name: /call tool/i }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("/workspace/generated-images/fox.png")).toBeTruthy();
  });

  it.each(["generate_image", "edit_image"])("a pinned %s action keeps its preview visible", (action) => {
    setToolCardDefault("always-collapsed");
    const pinned = message(action, "completed");
    const part = pinned.parts[0];
    if (part.kind !== "tool_call") throw new Error("missing tool call");
    part.toolName = `openai__${action}`;
    part.args = { prompt: "a red fox" };
    render(tree(pinned));
    expect(screen.getByRole("img", { name: "a red fox" })).toBeTruthy();
    expect(screen.getByText("/workspace/generated-images/fox.png")).toBeTruthy();
    expect(screen.getByRole("button", { name: new RegExp(`openai ${action.replaceAll("_", " ")}`, "i") }).getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps native hosted image receipts visible live and after reload", () => {
    setToolCardDefault("always-collapsed");
    const native = message("generate_image", "completed");
    const part = native.parts[0];
    if (part.kind !== "tool_call") throw new Error("missing tool call");
    part.toolName = "openai_native_image";
    part.args = { path: "/workspace/generated-images/fox.png", image_id: "img_1" };
    const view = render(tree(native));
    expect(screen.getByRole("img")).toBeTruthy();
    expect(screen.getByText("/workspace/generated-images/fox.png")).toBeTruthy();
    view.unmount();
    render(tree(JSON.parse(JSON.stringify(native))));
    expect(screen.getByRole("img").getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
  });

  it("smart policy auto-collapse does not hide the finished image", () => {
    const view = render(tree(message("generate_image", "running", false)));
    view.rerender(tree(message("generate_image", "completed")));
    expect(screen.getByRole("button", { name: /call tool/i }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("img")).toBeTruthy();
  });

  it("does not show stale previews on errors or non-image actions", () => {
    const view = render(tree(message("generate_image", "error")));
    expect(screen.queryByRole("img")).toBeNull();
    view.rerender(tree(message("text_to_speech", "completed")));
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("rejects non-raster MIME in persisted content", () => {
    const unsafe = message("generate_image", "completed");
    const part = unsafe.parts[0];
    if (part.kind !== "tool_call") throw new Error("missing tool call");
    part.result = { ...result, content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/svg+xml" }] };
    render(tree(unsafe));
    expect(screen.queryByRole("img")).toBeNull();
  });
});
