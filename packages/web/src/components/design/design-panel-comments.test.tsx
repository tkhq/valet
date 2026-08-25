// @vitest-environment jsdom
/**
 * Comments panel: lists open comments, resolves them, and flags a comment
 * whose anchor element no longer exists in the current revision (instead
 * of leaving it silently unpinnable).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DesignCommentWire } from "@valet/api/wire";
import { DesignPanelComments } from "./design-panel-comments";

function comment(overrides: Partial<DesignCommentWire>): DesignCommentWire {
  return {
    id: "c1",
    vdid: "vd-1",
    revision: "r-001",
    body: "Make the heading larger.",
    authorUserId: "u1",
    resolvedAt: null,
    createdAt: Date.now() - 60_000,
    ...overrides,
  };
}

const ANCHOR_GONE_COPY = "The target element no longer exists in the current revision.";

describe("DesignPanelComments", () => {
  it("lists open comments and hides resolved ones", () => {
    render(
      <DesignPanelComments
        comments={[
          comment({ id: "c1", body: "Open one." }),
          comment({ id: "c2", body: "Closed one.", resolvedAt: Date.now() }),
        ]}
        existingVdids={new Set(["vd-1"])}
        resolvingId={null}
        onResolve={() => {}}
      />,
    );
    expect(screen.getByText("Open one.")).toBeTruthy();
    expect(screen.queryByText("Closed one.")).toBeNull();
    expect(screen.getByText("Comments — 1 open")).toBeTruthy();
  });

  it("shows the empty state when nothing is open", () => {
    render(
      <DesignPanelComments
        comments={[comment({ resolvedAt: Date.now() })]}
        existingVdids={new Set()}
        resolvingId={null}
        onResolve={() => {}}
      />,
    );
    expect(screen.getByText("No open comments.")).toBeTruthy();
  });

  it("flags a comment whose anchor is gone from the current revision", () => {
    render(
      <DesignPanelComments
        comments={[
          comment({ id: "c1", vdid: "vd-alive" }),
          comment({ id: "c2", vdid: "vd-gone", body: "Orphaned." }),
        ]}
        existingVdids={new Set(["vd-alive"])}
        resolvingId={null}
        onResolve={() => {}}
      />,
    );
    expect(screen.getAllByText(ANCHOR_GONE_COPY).length).toBe(1);
  });

  it("Resolve calls onResolve with the comment id", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(
      <DesignPanelComments
        comments={[comment({ id: "c9" })]}
        existingVdids={new Set(["vd-1"])}
        resolvingId={null}
        onResolve={onResolve}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    expect(onResolve).toHaveBeenCalledWith("c9");
  });

  it("disables the button for the comment being resolved", () => {
    render(
      <DesignPanelComments
        comments={[comment({ id: "c9" })]}
        existingVdids={new Set(["vd-1"])}
        resolvingId="c9"
        onResolve={() => {}}
      />,
    );
    const busy = screen.getByRole<HTMLButtonElement>("button", { name: "Resolving…" });
    expect(busy.disabled).toBe(true);
  });
});
