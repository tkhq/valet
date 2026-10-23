// @vitest-environment jsdom
/**
 * Thread edit and fork in the transcript
 * (docs/specs/2026-10-22-thread-edit-fork-design.md): which messages offer
 * Edit, the rows an edit dims and hides, and the branch-note divider.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { StreamMessage } from "~/stores/stream";
import { ApiError } from "~/api/client";
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
  return <QueryClientProvider client={new QueryClient()}><TooltipProvider>{node}</TooltipProvider></QueryClientProvider>;
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
    render(<BranchNoteDivider notes={[edit]} onReturn={onReturn} />);
    fireEvent.click(screen.getByRole("button", { name: /Edited · 1 action from the earlier version still stands/ }));
    expect(screen.getByText(/github.create_pull_request: Open the fix/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "https://example.test/pr/7" })).toBeTruthy();
    expect(screen.getByText(/working directory keeps any file changes/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go back to this version" }));
    expect(screen.getByText(/Approval choices from that version still apply: Always allow for me: Create a pull request/)).toBeTruthy();
    await waitFor(() => expect(onReturn).toHaveBeenCalledWith("note-1", { restoreFiles: false }));
  });

  it("labels a run of edits once and lists each version, newest first", () => {
    const older = { ...edit, id: "note-0", branch: { ...edit.branch!, actions: [], filesChanged: false } };
    render(<BranchNoteDivider notes={[older, edit]} onReturn={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "2 earlier versions kept · 1 action still stands" }));
    expect(screen.getAllByText(/version left/).map((el) => el.textContent)).toEqual(["Latest version left", "Earlier version left"]);
    expect(screen.getAllByRole("button", { name: "Go back to this version" })).toHaveLength(2);
  });

  it("lists undone files and brings them back with Go back", async () => {
    const onReturn = vi.fn().mockResolvedValue(undefined);
    const undone = { ...edit, branch: { ...edit.branch!, files: { changed: ["app/a.txt"], skipped: ["app/c.txt"], failed: [], canBringBack: true } } };
    render(<BranchNoteDivider notes={[undone]} onReturn={onReturn} />);
    fireEvent.click(screen.getByRole("button", { name: /Edited/ }));
    expect(screen.getByText("Undid file changes: app/a.txt.")).toBeTruthy();
    expect(screen.getByText("Left as they are, because they changed later: app/c.txt.")).toBeTruthy();
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Go back to this version" }));
    await waitFor(() => expect(onReturn).toHaveBeenCalledWith("note-1", { restoreFiles: true }));
  });

  it("shows the server's reason when going back is refused", async () => {
    const onReturn = vi.fn().mockRejectedValue(new ApiError(400, "Bad Request", { error: "Valet is working in this thread. Stop it, then go back to the earlier version." }));
    render(<BranchNoteDivider notes={[edit]} onReturn={onReturn} />);
    fireEvent.click(screen.getByRole("button", { name: /Edited/ }));
    fireEvent.click(screen.getByRole("button", { name: "Go back to this version" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Valet is working in this thread. Stop it, then go back to the earlier version.");
  });

  it("links a fork note to its original thread and offers no way back", () => {
    const onOpenThread = vi.fn();
    const fork = msg("note-2", {
      role: "system",
      branch: { kind: "fork", actions: [], moreActions: 0, filesChanged: false, canReturn: false, grants: [], source: { threadId: "t0", sameWorkingDirectory: false } },
    });
    render(<BranchNoteDivider notes={[fork]} onReturn={vi.fn()} onOpenThread={onOpenThread} />);
    fireEvent.click(screen.getByRole("button", { name: /Branched from another thread/ }));
    expect(screen.getByText(/files from the original thread are not here/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Go back to this version" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open the original thread" }));
    expect(onOpenThread).toHaveBeenCalledWith("t0");
  });
});
