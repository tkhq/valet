// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { StreamMessage } from "~/stores/stream";
import { useThreadEdit } from "./use-thread-edit";

vi.mock("~/api/queries", () => ({ useReturnToBranch: () => ({ mutateAsync: vi.fn() }) }));

afterEach(cleanup);

describe("editing artifact conversation prompts", () => {
  const human = "  Improve this:\n```html\n<section>  ";
  const contextual = `${human}\n\n[valet-artifact-context]: # ${JSON.stringify('Current artifact context: {"content":"Private source"}')}`;
  const message: StreamMessage = { id: "m1", sessionId: "s1", threadId: "t1", role: "user", content: contextual, parts: [], createdAt: 0 };

  it("hydrates the edit draft with only the exact human request", () => {
    const { result } = renderHook(() => useThreadEdit("s1", "t1", { dataUpdatedAt: 0 }, [message]));
    act(() => result.current.startEdit(message));
    expect(result.current.composer.editTarget).toEqual({ messageId: "m1", text: human, images: [], droppedFiles: 0 });
  });

  it("does not rewrite assistant text passed to the edit handler", () => {
    const { result } = renderHook(() => useThreadEdit("s1", "t1", { dataUpdatedAt: 0 }, []));
    act(() => result.current.startEdit({ ...message, role: "assistant" }));
    expect(result.current.composer.editTarget?.text).toBe(contextual);
  });
});
