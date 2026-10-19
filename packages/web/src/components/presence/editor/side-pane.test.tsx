// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { line } from "../test-fixtures";
import { text } from "../sentences";
import { SidePane, collisionWords, editedAgo, type SidePaneProps } from "./side-pane";

function props(over: Partial<SidePaneProps> = {}): SidePaneProps {
  return {
    title: "This line reads",
    sentence: [text("When a check completes on "), { kind: "place", text: "acme/api", service: "github", subject: "github:acme/api" }, text(", work in its own thread.")],
    steps: ["A check completes on acme/api.", "Valet reads the event.", "It works in its own thread, as Valet."],
    blocker: null,
    saveLabel: "Save",
    pending: false,
    error: null,
    onCancel: () => {},
    onSave: () => {},
    confirmingDiscard: false,
    onKeepEditing: () => {},
    onDiscard: () => {},
    ...over,
  };
}

describe("SidePane", () => {
  it("reads the sentence, the example, the permissions note, and the footer", () => {
    render(<SidePane {...props({ editedAt: Date.now() - 3 * 86_400_000 })} />);
    expect(screen.getByText("This line reads")).toBeTruthy();
    expect(screen.getByTestId("editor-sentence").textContent).toBe("When a check completes on acme/api, work in its own thread.");
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "1A check completes on acme/api.", "2Valet reads the event.", "3It works in its own thread, as Valet.",
    ]);
    expect(screen.getByText("Uses this workspace's existing access. Saving grants nothing new.")).toBeTruthy();
    expect(screen.getByText("Edited 3 days ago")).toBeTruthy();
  });

  it("disables Save with its reason beside it", () => {
    const onSave = vi.fn();
    render(<SidePane {...props({ blocker: "Pick at least one event.", saveLabel: "Create", onSave })} />);
    const create = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(screen.getByText("Pick at least one event.")).toBeTruthy();
    expect(create.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("shows the review notice and Turn on", () => {
    render(<SidePane {...props({ saveLabel: "Turn on", review: { replaces: { id: "l0", name: "Old CI" } } })} />);
    expect(screen.getByRole("note").textContent).toBe("Proposed by the assistant. Turning it on turns off Old CI.");
    expect(screen.getByRole("button", { name: "Turn on" })).toBeTruthy();
  });

  it("offers no Turn on for a stale proposal", () => {
    render(<SidePane {...props({ saveLabel: "Turn on", review: { stale: true } })} />);
    expect(screen.getByRole("note").textContent).toBe(
      "Proposed by the assistant. The line this proposal replaces is gone. Delete this proposal and make a new line.",
    );
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
  });

  it("asks before it discards changes", () => {
    const onDiscard = vi.fn();
    render(<SidePane {...props({ confirmingDiscard: true, onDiscard })} />);
    expect(screen.getByText("Discard your changes?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDiscard).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Keep editing" })).toBeTruthy();
  });

  it("names a collision in words and offers Save anyway", () => {
    const other = line("l2", { name: "Review follow-up", eventKeys: ["github.check_run.completed"], filters: [{ field: "repo", op: "eq", value: "acme/api" }] });
    const onSaveAnyway = vi.fn();
    render(<SidePane {...props({ collisions: { report: { blocking: [{ subscription: other, relation: "equal", sharedKeys: ["github.check_run.completed"] }], overlapping: [] }, committed: false }, onSaveAnyway })} />);
    expect(screen.getByText(/also acts on completed checks for acme\/api\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save anyway" }));
    expect(onSaveAnyway).toHaveBeenCalled();
  });

  it("formats the edit time", () => {
    const now = 1_000_000_000_000;
    expect(editedAgo(now - 10_000, now)).toBe("Edited just now");
    expect(editedAgo(now - 5 * 60_000, now)).toBe("Edited 5 minutes ago");
    expect(editedAgo(now - 3_600_000, now)).toBe("Edited 1 hour ago");
    expect(collisionWords(["slack.app_mention", "github.push"])).toBe("mentions or pushes");
  });
});
