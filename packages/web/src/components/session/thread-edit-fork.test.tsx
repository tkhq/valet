// @vitest-environment jsdom
/**
 * Thread edit and fork in the transcript
 * (docs/specs/2026-10-22-thread-edit-fork-design.md): which messages offer
 * Edit, the rows an edit dims and hides, and the branch-note divider.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { StreamMessage } from "~/stores/stream";
import { api, ApiError } from "~/api/client";
import { TooltipProvider } from "~/components/primitives";
import { MessageList, editableMessageIds, groupBranchNotes } from "./message-list";
import { BranchNoteDivider } from "./branch-note-divider";

const ME = { id: "me" };
const OTHER = { id: "other", name: "Teammate" };

function msg(id: string, overrides: Partial<StreamMessage> = {}): StreamMessage {
  return { id, sessionId: "s1", threadId: "t1", role: "user", content: id, parts: [], createdAt: 1, ...overrides };
}
const reply = (id: string) => msg(id, { role: "assistant", completed: true, parts: [{ kind: "text", text: id }] });

function wrap(node: ReactNode) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider>{node}</TooltipProvider></QueryClientProvider>;
}

describe("editableMessageIds", () => {
  it("offers the viewer's own typed messages", () => {
    const list = [msg("u1", { author: ME }), reply("a1"), msg("u2", { author: ME }), reply("a2")];
    expect([...editableMessageIds(list, "me")]).toEqual(["u2", "u1"]);
  });

  it("stops at another person's message: an edit before it would remove it", () => {
    const list = [msg("u1", { author: ME }), reply("a1"), msg("u2", { author: OTHER }), reply("a2"), msg("u3", { author: ME })];
    expect([...editableMessageIds(list, "me")]).toEqual(["u3"]);
  });

  it("skips client-only rows, Slack messages, and authorless rows", () => {
    const list = [
      msg("u1"),
      msg("u2", { author: ME, channelType: "slack" }),
      msg("u3", { author: ME, persistence: "optimistic" }),
    ];
    expect([...editableMessageIds(list, "me")]).toEqual([]);
  });
});

describe("MessageList edit and branch actions", () => {
  const list = [msg("u1", { author: ME }), reply("a1"), msg("u2", { author: OTHER }), reply("a2")];

  it("offers Edit only where the viewer may edit, and Branch on typed messages and finished replies", () => {
    const onEdit = vi.fn();
    const onBranch = vi.fn();
    render(wrap(<MessageList messages={[...list, msg("u3", { author: ME })]} threadId="t1" viewerId="me" onEdit={onEdit} onBranch={onBranch} ratings={false} />));
    const edits = screen.getAllByRole("button", { name: "Edit message" });
    expect(edits).toHaveLength(1);
    fireEvent.click(edits[0]!);
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "u3" }));
    expect(screen.getAllByRole("button", { name: "Branch into a new thread" })).toHaveLength(5);
  });

  it("dims the edited message and every row after it", () => {
    const { container } = render(wrap(<MessageList messages={list} threadId="t1" viewerId="me" editingId="a1" ratings={false} />));
    const dimmed = [...container.querySelectorAll("article[aria-disabled]")].map((row) => row.getAttribute("data-message-id"));
    expect(dimmed).toEqual(["a1", "u2", "a2"]);
  });

  it("hides the replaced rows after Send, a still-streaming one included, and shows new rows", () => {
    const streaming = msg("a2-live", { role: "assistant", persistence: "streaming" });
    const sent = msg("local-1", { author: ME, content: "edited", persistence: "optimistic" });
    const { container } = render(wrap(
      <MessageList messages={[...list, streaming, sent]} threadId="t1" viewerId="me" hiddenIds={new Set(["u2", "a2", "a2-live"])} ratings={false} />,
    ));
    const shown = [...container.querySelectorAll("article")].map((row) => row.getAttribute("data-message-id"));
    expect(shown).toEqual(["u1", "a1", "local-1"]);
  });
});

describe("groupBranchNotes", () => {
  const note = (id: string, kind: "edit" | "return" | "fork") =>
    msg(id, { role: "system", branch: { kind, actions: [], moreActions: 0, filesChanged: false, canReturn: kind !== "fork", grants: [] } });
  it("puts repeated edits of one message in one row and keeps a fork note apart", () => {
    const rows = groupBranchNotes([note("f", "fork"), note("e1", "edit"), note("e2", "edit"), msg("u1"), note("r1", "return")]
      .map((message) => ({ kind: "message" as const, message })));
    expect(rows.map((row) => row.kind === "branch" ? row.notes.map((n) => n.id).join("+") : row.kind)).toEqual(["f", "e1+e2", "message", "r1"]);
  });
});

describe("BranchNoteDivider", () => {
  beforeEach(() => {
    vi.spyOn(api, "branchPreview").mockReset().mockResolvedValue({ messages: [], hasMore: false });
  });
  const edit = msg("note-1", {
    role: "system",
    content: "note",
    branch: {
      kind: "edit",
      actions: [{ label: "github.create_pull_request: Open the fix", count: 1, urls: ["https://example.test/pr/7"] }],
      moreActions: 0,
      filesChanged: true,
      canReturn: true,
      grants: ["Always allow for me: Create a pull request"],
    },
  });

  it("names what still stands and goes back to the earlier version", async () => {
    const onReturn = vi.fn().mockResolvedValue(undefined);
    render(wrap(<BranchNoteDivider notes={[edit]} onReturn={onReturn} />));
    fireEvent.click(screen.getByRole("button", { name: /Edited · 1 action from the earlier version still stands/ }));
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByText(/github.create_pull_request: Open the fix/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "https://example.test/pr/7" })).toBeTruthy();
    expect(screen.getByText(/working directory keeps any file changes/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    expect(screen.getByText(/Approval choices from that version still apply: Always allow for me: Create a pull request/)).toBeTruthy();
    await waitFor(() => expect(onReturn).toHaveBeenCalledWith("note-1", { restoreFiles: false }));
  });

  it("keeps the panel open during restore and closes it only after restore succeeds", async () => {
    let finishRestore: (() => void) | undefined;
    const onReturn = vi.fn(() => new Promise<void>((resolve) => { finishRestore = resolve; }));
    render(wrap(<BranchNoteDivider notes={[edit]} onReturn={onReturn} />));
    const trigger = screen.getByRole("button", { name: /Edited/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    expect(screen.getByRole("dialog", { name: "Version history" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restore this version" }).hasAttribute("disabled")).toBe(true);
    await act(async () => { finishRestore?.(); });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("labels a run of edits once and lists each version, newest first", () => {
    const older = { ...edit, id: "note-0", branch: { ...edit.branch!, actions: [], filesChanged: false } };
    render(wrap(<BranchNoteDivider notes={[older, edit]} onReturn={vi.fn()} />));
    fireEvent.click(screen.getByRole("button", { name: "2 earlier versions kept · 1 action still stands" }));
    expect(screen.getAllByText(/version left/).map((el) => el.textContent)).toEqual(["Latest version left", "Earlier version left"]);
    expect(screen.queryByRole("button", { name: "Restore this version" })).toBeNull();
    expect(api.branchPreview).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "View" })[0]!);
    expect(screen.getAllByRole("button", { name: "Restore this version" })).toHaveLength(1);
  });

  it("lists undone files and brings them back with Go back", async () => {
    const onReturn = vi.fn().mockResolvedValue(undefined);
    const undone = { ...edit, branch: { ...edit.branch!, files: { changed: ["app/a.txt"], skipped: ["app/c.txt"], failed: [], canBringBack: true } } };
    render(wrap(<BranchNoteDivider notes={[undone]} onReturn={onReturn} />));
    fireEvent.click(screen.getByRole("button", { name: /Edited/ }));
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByText("Undid file changes: app/a.txt.")).toBeTruthy();
    expect(screen.getByText("Left as they are, because they changed later: app/c.txt.")).toBeTruthy();
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    await waitFor(() => expect(onReturn).toHaveBeenCalledWith("note-1", { restoreFiles: true }));
  });

  it("shows the server's reason when going back is refused", async () => {
    const onReturn = vi.fn().mockRejectedValue(new ApiError(400, "Bad Request", { error: "Valet is working in this thread. Stop it, then go back to the earlier version." }));
    render(wrap(<BranchNoteDivider notes={[edit]} onReturn={onReturn} />));
    fireEvent.click(screen.getByRole("button", { name: /Edited/ }));
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Valet is working in this thread. Stop it, then go back to the earlier version.");
    expect(screen.getByRole("dialog", { name: "Version history" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restore this version" }).hasAttribute("disabled")).toBe(false);
  });

  it("bounds a large history and inspects only the selected transcript before restoring it", async () => {
    const onReturn = vi.fn().mockResolvedValue(undefined);
    const notes = Array.from({ length: 100 }, (_, index) => msg(`version-${index}`, {
      role: "system",
      createdAt: index + 1,
      branch: { ...edit.branch!, version: { excerpt: `Message ${index}`, createdAt: 1700000000000 + index * 1000 } },
    }));
    vi.mocked(api.branchPreview).mockImplementation(async (_threadId, noteEntryId) => ({
      messages: [msg(`preview-${noteEntryId}`, { content: `Transcript ${noteEntryId}` })], hasMore: false,
    }));
    render(wrap(<BranchNoteDivider notes={notes} onReturn={onReturn} />));
    fireEvent.click(screen.getByRole("button", { name: /100 earlier versions/ }));
    expect(screen.getByLabelText("Earlier versions").style.height).toBe("192px");
    expect(screen.getAllByRole("listitem")).toHaveLength(20);
    expect(screen.queryByText("Message 79")).toBeNull();
    for (let page = 0; page < 4; page++) fireEvent.click(screen.getByRole("button", { name: "Show older versions" }));
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(100);
    expect(screen.queryByRole("button", { name: "Show older versions" })).toBeNull();
    expect(rows[0]!.textContent).toContain("Message 99");
    expect(rows[0]!.querySelector("time")?.getAttribute("datetime")).toBe(new Date(1700000099000).toISOString());
    expect(api.branchPreview).not.toHaveBeenCalled();
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "View" }));
    expect(await screen.findByText("Transcript version-99")).toBeTruthy();
    expect(api.branchPreview).toHaveBeenCalledWith("t1", "version-99", undefined);
    expect(onReturn).not.toHaveBeenCalled();
    fireEvent.click(within(rows[99]!).getByRole("button", { name: "View" }));
    expect(await screen.findByText("Transcript version-0")).toBeTruthy();
    expect(screen.queryByText("Transcript version-99")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Restore this version" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    await waitFor(() => expect(onReturn).toHaveBeenCalledWith("version-0", { restoreFiles: false }));
  });

  it("uses the note time for legacy versions and offers retry after preview failure", async () => {
    vi.mocked(api.branchPreview).mockRejectedValueOnce(new ApiError(404, "Not found", { error: "This version is not here. Reload the thread and choose another version." }));
    render(wrap(<BranchNoteDivider notes={[edit]} />));
    fireEvent.click(screen.getByRole("button", { name: /Edited/ }));
    expect(screen.getByText("Latest version left")).toBeTruthy();
    expect(screen.getByLabelText("Earlier versions").querySelector("time")?.getAttribute("datetime")).toBe(new Date(edit.createdAt).toISOString());
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(await screen.findByText(/This version is not here/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No messages in this version.")).toBeTruthy();
  });

  it("keeps history outside the conversation and resets its row limit and selection on close or thread change", async () => {
    const notes = Array.from({ length: 100 }, (_, index) => ({ ...edit, id: `note-${index}` }));
    const { rerender } = render(wrap(<BranchNoteDivider notes={notes} onReturn={vi.fn()} />));
    const trigger = screen.getByRole("button", { name: /100 earlier versions/ });
    trigger.focus();
    fireEvent.click(trigger);
    const panel = screen.getByRole("dialog", { name: "Version history" });
    expect(screen.getByTestId("branch-note").contains(panel)).toBe(false);
    expect(panel.className).toContain("right-0");
    expect(panel.className).toContain("h-dvh");
    expect(panel.className).toContain("overflow-hidden");
    fireEvent.click(screen.getByRole("button", { name: "Show older versions" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(40);
    fireEvent.click(screen.getAllByRole("button", { name: "View" })[0]!);
    await screen.findByText("No messages in this version.");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.click(trigger);
    expect(screen.getAllByRole("listitem")).toHaveLength(20);
    expect(screen.queryByLabelText("Selected version transcript")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show older versions" }));
    fireEvent.click(screen.getAllByRole("button", { name: "View" })[0]!);
    rerender(wrap(<BranchNoteDivider notes={notes.map((note) => ({ ...note, threadId: "t2" }))} onReturn={vi.fn()} />));
    expect(screen.getAllByRole("listitem")).toHaveLength(20);
    expect(screen.queryByLabelText("Selected version transcript")).toBeNull();
  });

  it("loads every older preview page in order and preserves the transcript after a page failure", async () => {
    let olderAttempts = 0;
    vi.mocked(api.branchPreview).mockImplementation(async (_threadId, _noteEntryId, cursor) => {
      if (!cursor) return { messages: [msg("newest", { content: "Newest message" })], hasMore: true, nextCursor: "middle-cursor" };
      if (cursor === "middle-cursor") {
        if (olderAttempts++ === 0) throw new ApiError(503, "Unavailable", { error: "Preview storage is busy. Try again." });
        return { messages: [msg("middle", { content: "Middle message" })], hasMore: true, nextCursor: "oldest-cursor" };
      }
      return { messages: [msg("oldest", { content: "Oldest message" })], hasMore: false };
    });
    render(wrap(<BranchNoteDivider notes={[edit]} />));
    fireEvent.click(screen.getByRole("button", { name: /Edited/ }));
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    await screen.findByText("Newest message");
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Preview storage is busy. Try again.");
    expect(screen.getByText("Newest message")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await screen.findByText("Middle message");
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await screen.findByText("Oldest message");
    const transcript = screen.getByLabelText("Selected version transcript");
    expect([...transcript.querySelectorAll("article")].map((row) => row.getAttribute("data-message-id"))).toEqual(["oldest", "middle", "newest"]);
    expect(screen.queryByRole("button", { name: "Load older messages" })).toBeNull();
    expect(api.branchPreview).toHaveBeenCalledWith("t1", "note-1", "middle-cursor");
    expect(api.branchPreview).toHaveBeenCalledWith("t1", "note-1", "oldest-cursor");
    expect(transcript.querySelector("form")).toBeNull();
    expect(within(transcript).queryByRole("button", { name: /Edit|Branch|Reply|Rate/ })).toBeNull();
  });

  it("shows compact read-only boundaries for earlier branch notes instead of engine instructions", async () => {
    const kinds = ["edit", "return", "fork"] as const;
    vi.mocked(api.branchPreview).mockResolvedValue({
      messages: [msg("ordinary", { content: "Visible message" }), ...kinds.map((kind) => msg(`boundary-${kind}`, {
        role: "system",
        content: `The person edited this thread: internal instruction for ${kind}`,
        parts: [{ kind: "text", text: `Internal model note for ${kind}` }],
        branch: { kind, actions: [], moreActions: 0, filesChanged: false, canReturn: true, grants: [] },
      }))],
      hasMore: false,
    });
    render(wrap(<BranchNoteDivider notes={[edit]} onReturn={vi.fn()} />));
    fireEvent.click(screen.getByRole("button", { name: /Edited/ }));
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(await screen.findByText("Earlier edit")).toBeTruthy();
    const transcript = screen.getByLabelText("Selected version transcript");
    expect(within(transcript).getByText("Returned to an earlier version")).toBeTruthy();
    expect(within(transcript).getByText("Branched from another thread")).toBeTruthy();
    expect(within(transcript).getByText("Visible message")).toBeTruthy();
    expect(transcript.textContent).not.toMatch(/The person edited|Internal model note/);
    expect(within(transcript).queryByRole("button")).toBeNull();
    expect(transcript.querySelector("form")).toBeNull();
  });

  it("links a fork note to its original thread and offers no way back", () => {
    const onOpenThread = vi.fn();
    const fork = msg("note-2", {
      role: "system",
      branch: { kind: "fork", actions: [], moreActions: 0, filesChanged: false, canReturn: false, grants: [], source: { threadId: "t0", sameWorkingDirectory: false } },
    });
    render(wrap(<BranchNoteDivider notes={[fork]} onReturn={vi.fn()} onOpenThread={onOpenThread} />));
    fireEvent.click(screen.getByRole("button", { name: /Branched from another thread/ }));
    expect(screen.getByText(/files from the original thread are not here/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restore this version" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open the original thread" }));
    expect(onOpenThread).toHaveBeenCalledWith("t0");
  });
});
