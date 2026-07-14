// @vitest-environment jsdom
/**
 * Memory doc pane (Task 6 brief): badges derived from frontmatter + the
 * tree entry, frontmatter never shown raw, and the "Ask {name} to update
 * this" footer seeds the composer-prefill store before navigating.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ApiError } from "~/api/client";
import { useComposerPrefillStore } from "~/stores/composer-prefill";

const docMock = vi.fn();

vi.mock("~/api/memory", () => ({
  useMemoryDoc: (path: string) => docMock(path),
}));

vi.mock("~/api/orchestrator", () => ({
  useOrchestratorInfo: () => ({ data: { name: "Nova" } }),
}));

import { MemoryDoc, memoryDocPrefillText } from "./memory-doc";

function renderedDoc(rendered: string) {
  return {
    kind: "file" as const,
    path: "preferences/style.md",
    rendered,
    file: {
      path: "preferences/style.md",
      title: "Writing style",
      content: "body",
      type: "preference",
      pinned: 1,
      updatedAt: Date.now() - 60_000,
    },
  };
}

describe("MemoryDoc", () => {
  beforeEach(() => {
    docMock.mockReset();
    useComposerPrefillStore.setState({ text: null });
  });

  it("renders title, frontmatter-derived badges, and body — never raw frontmatter", () => {
    const rendered =
      '---\n' +
      'type: "preference"\n' +
      'title: "Writing style"\n' +
      'tags: ["voice", "tone"]\n' +
      'timestamp: "2026-07-13T00:00:00.000Z"\n' +
      'valet:\n' +
      '  sensitivity: "shareable"\n' +
      '  origin: "user-stated"\n' +
      '---\n' +
      '\n' +
      'Keep it warm and direct.\n';

    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc(rendered), refetch: vi.fn() });

    render(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);

    expect(screen.getByRole("heading", { name: /Writing style/ })).toBeTruthy();
    expect(screen.getByText("preference")).toBeTruthy();
    expect(screen.getByText("voice")).toBeTruthy();
    expect(screen.getByText("tone")).toBeTruthy();
    expect(screen.getByText("shareable")).toBeTruthy();
    expect(screen.getByText("user-stated")).toBeTruthy();
    expect(screen.getByText("Keep it warm and direct.")).toBeTruthy();
    expect(screen.queryByText(/timestamp:/)).toBeNull();
    expect(screen.queryByText(/valet:/)).toBeNull();
  });

  it("omits the sensitivity/origin badges when absent from frontmatter", () => {
    const rendered = '---\ntype: "note"\ntitle: "Plain"\n---\n\nJust text.\n';
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc(rendered), refetch: vi.fn() });

    render(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);
    expect(screen.getByText("note")).toBeTruthy();
    expect(screen.queryByText("shareable")).toBeNull();
    expect(screen.queryByText("user-stated")).toBeNull();
  });

  it("shows an in-voice empty state on 404", () => {
    docMock.mockReturnValue({
      isLoading: false,
      error: new ApiError(404, "not found"),
      data: undefined,
      refetch: vi.fn(),
    });
    render(<MemoryDoc path="journal/2026-07-13.md" onNavigateToChat={vi.fn()} />);
    expect(screen.getByText(/Talk to Nova/)).toBeTruthy();
  });

  it("shows a retry affordance on a non-404 error", () => {
    const refetch = vi.fn();
    docMock.mockReturnValue({
      isLoading: false,
      error: new ApiError(500, "boom"),
      data: undefined,
      refetch,
    });
    render(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);
    screen.getByText("Retry").click();
    expect(refetch).toHaveBeenCalled();
  });

  it("seeds the composer-prefill store and navigates when 'Ask Nova to update this' is clicked", () => {
    const rendered = '---\ntype: "note"\n---\n\nBody.\n';
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc(rendered), refetch: vi.fn() });
    const onNavigateToChat = vi.fn();

    render(<MemoryDoc path="preferences/style.md" onNavigateToChat={onNavigateToChat} />);
    screen.getByText("Ask Nova to update this").click();

    expect(useComposerPrefillStore.getState().text).toBe(
      "Update memory file preferences/style.md: ",
    );
    expect(onNavigateToChat).toHaveBeenCalled();
  });
});

describe("memoryDocPrefillText", () => {
  it("formats the update-file prefill", () => {
    expect(memoryDocPrefillText("journal/2026-07-13.md")).toBe(
      "Update memory file journal/2026-07-13.md: ",
    );
  });
});
