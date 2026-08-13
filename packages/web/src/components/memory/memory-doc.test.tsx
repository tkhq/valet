// @vitest-environment jsdom
/**
 * Memory doc pane (Task 6 brief): badges derived from frontmatter + the
 * tree entry, frontmatter never shown raw, and the "Ask {name} to update
 * this" footer seeds the composer-prefill store before navigating.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { ApiError, api } from "~/api/client";
import { useComposerPrefillStore } from "~/stores/composer-prefill";

const docMock = vi.fn();

vi.mock("~/api/memory", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/api/memory")>();
  return {
    ...original,
    useMemoryDoc: (path: string) => docMock(path),
  };
});

vi.mock("~/api/orchestrator", () => ({
  useOrchestratorInfo: () => ({ data: { name: "Nova" } }),
}));

import { MemoryDoc, memoryDocPrefillText } from "./memory-doc";

// The component uses react-query mutations now — every render needs a
// provider. Retries off so mutation errors surface synchronously.
function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

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
      pinned: true,
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

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);

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

  /**
   * `pinned` is a boolean on the wire (`memory_files.pinned` is a Postgres
   * boolean). The reader tested `=== 1` against it, so the pin never
   * rendered — and this suite's own fixture said `pinned: 1`, which is why
   * the bug survived. These two cases pin the real contract.
   */
  it("marks a pinned file in the heading", () => {
    docMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: renderedDoc("body"),
      refetch: vi.fn(),
    });

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);

    expect(screen.getByRole("heading", { name: /Writing style/ }).textContent).toContain("\ud83d\udccc");
  });

  it("leaves an unpinned file's heading unmarked", () => {
    const doc = renderedDoc("body");
    docMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: { ...doc, file: { ...doc.file, pinned: false } },
      refetch: vi.fn(),
    });

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);

    expect(screen.getByRole("heading", { name: /Writing style/ }).textContent).not.toContain("\ud83d\udccc");
  });

  it("omits the sensitivity/origin badges when absent from frontmatter", () => {
    const rendered = '---\ntype: "note"\ntitle: "Plain"\n---\n\nJust text.\n';
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc(rendered), refetch: vi.fn() });

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);
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
    renderWithClient(<MemoryDoc path="journal/2026-07-13.md" onNavigateToChat={vi.fn()} />);
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
    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);
    screen.getByText("Retry").click();
    expect(refetch).toHaveBeenCalled();
  });

  it("seeds the composer-prefill store and navigates when 'Ask Nova to update this' is clicked", () => {
    const rendered = '---\ntype: "note"\n---\n\nBody.\n';
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc(rendered), refetch: vi.fn() });
    const onNavigateToChat = vi.fn();

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={onNavigateToChat} />);
    screen.getByText("Ask Nova to update this").click();

    expect(useComposerPrefillStore.getState().text).toBe(
      "Update memory file preferences/style.md: ",
    );
    expect(onNavigateToChat).toHaveBeenCalled();
  });

  it("edits: textarea seeds from stored content, save PUTs and exits edit mode", async () => {
    const rendered = '---\ntype: "note"\n---\n\nBody.\n';
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc(rendered), refetch: vi.fn() });
    const write = vi.spyOn(api, "writeMemoryDoc").mockResolvedValue({});

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);
    fireEvent.click(screen.getByText("Edit"));

    const textarea = screen.getByLabelText("Memory content") as HTMLTextAreaElement;
    expect(textarea.value).toBe("body"); // file.content, not the rendered doc
    fireEvent.change(textarea, { target: { value: "new body" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() =>
      expect(write).toHaveBeenCalledWith({ path: "preferences/style.md", content: "new body" }),
    );
    await waitFor(() => expect(screen.queryByLabelText("Memory content")).toBeNull());
    write.mockRestore();
  });

  it("save is disabled when the draft is empty (delete is the way to clear)", () => {
    const rendered = '---\ntype: "note"\n---\n\nBody.\n';
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc(rendered), refetch: vi.fn() });

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByLabelText("Memory content"), { target: { value: "  " } });
    expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("delete is confirm-gated and calls onDeleted after the DELETE succeeds", async () => {
    const rendered = '---\ntype: "note"\n---\n\nBody.\n';
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc(rendered), refetch: vi.fn() });
    const del = vi.spyOn(api, "deleteMemoryDoc").mockResolvedValue({});
    const onDeleted = vi.fn();

    renderWithClient(
      <MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} onDeleted={onDeleted} />,
    );
    fireEvent.click(screen.getByText("Delete"));
    expect(del).not.toHaveBeenCalled(); // first click only arms the confirm
    fireEvent.click(screen.getByText("Confirm delete"));

    await waitFor(() => expect(del).toHaveBeenCalledWith("preferences/style.md"));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    del.mockRestore();
  });

  /** `PUT /api/memory` has always honoured `pinned`; the doc view had no
   * control for it, so a pin could only be set by the agent. The write
   * carries no `content`, which is what keeps the body untouched. */
  it("pins a file with a metadata-only write", async () => {
    const doc = renderedDoc("body");
    docMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: { ...doc, file: { ...doc.file, pinned: false } },
      refetch: vi.fn(),
    });
    const write = vi.spyOn(api, "writeMemoryDoc").mockResolvedValue({});

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);
    fireEvent.click(screen.getByText("Pin"));

    await waitFor(() =>
      expect(write).toHaveBeenCalledWith({ path: "preferences/style.md", pinned: true }),
    );
    write.mockRestore();
  });

  it("unpins a pinned file", async () => {
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc("body"), refetch: vi.fn() });
    const write = vi.spyOn(api, "writeMemoryDoc").mockResolvedValue({});

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);
    fireEvent.click(screen.getByText("Unpin"));

    await waitFor(() =>
      expect(write).toHaveBeenCalledWith({ path: "preferences/style.md", pinned: false }),
    );
    write.mockRestore();
  });

  /** The memory corpus cross-references itself with relative paths. Those
   * used to open a new tab that went nowhere. */
  it("opens a cross-reference in place instead of a new tab", () => {
    const rendered = '---\ntype: "note"\n---\n\nSee [alice](../people/alice.md).\n';
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc(rendered), refetch: vi.fn() });
    const onOpenPath = vi.fn();

    renderWithClient(
      <MemoryDoc path="journal/2026-08-12.md" onNavigateToChat={vi.fn()} onOpenPath={onOpenPath} />,
    );

    const link = screen.getByText("alice").closest("a");
    if (!link) throw new Error("no anchor around the cross-reference");
    expect(link.target).toBe("");

    const cancel = (e: Event) => e.preventDefault();
    document.addEventListener("click", cancel);
    try {
      fireEvent.click(link, { button: 0 });
    } finally {
      document.removeEventListener("click", cancel);
    }
    expect(onOpenPath).toHaveBeenCalledWith("people/alice.md");
  });

  it("delete confirm can be cancelled without calling the API", () => {
    const rendered = '---\ntype: "note"\n---\n\nBody.\n';
    docMock.mockReturnValue({ isLoading: false, error: null, data: renderedDoc(rendered), refetch: vi.fn() });
    const del = vi.spyOn(api, "deleteMemoryDoc").mockResolvedValue({});

    renderWithClient(<MemoryDoc path="preferences/style.md" onNavigateToChat={vi.fn()} />);
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Confirm delete")).toBeNull();
    expect(del).not.toHaveBeenCalled();
    del.mockRestore();
  });
});

describe("memoryDocPrefillText", () => {
  it("formats the update-file prefill", () => {
    expect(memoryDocPrefillText("journal/2026-07-13.md")).toBe(
      "Update memory file journal/2026-07-13.md: ",
    );
  });
});
