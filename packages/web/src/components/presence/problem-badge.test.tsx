// @vitest-environment jsdom
/**
 * The problem badge and the inline fix (docs/specs/2026-10-16-presence-hub-design.md
 * Part C step 5, Part D).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { AssistantThreadPolicy } from "@valet/shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("./thread-picker", () => ({
  ThreadPicker: ({ onPick }: { onPick: (policy: Extract<AssistantThreadPolicy, { mode: "existing" }>, title: string) => void }) => (
    <button type="button" onClick={() => onPick({ mode: "existing", sessionId: "s", threadId: "t" }, "T")}>Pick</button>
  ),
}));

import { isPinProblem, PIN_UNAVAILABLE, PIN_UNAVAILABLE_LEGACY, ProblemBadge, ThreadProblem } from "./problem-badge";

describe("isPinProblem", () => {
  it("matches the pin text and the text older dead letters carry", () => {
    expect(PIN_UNAVAILABLE).toBe("Pick another thread in Presence.");
    expect(isPinProblem(PIN_UNAVAILABLE)).toBe(true);
    expect(isPinProblem(PIN_UNAVAILABLE_LEGACY)).toBe(true);
    expect(isPinProblem("Reconnect Slack in Integrations.")).toBe(false);
    expect(isPinProblem(null)).toBe(false);
    expect(isPinProblem(undefined)).toBe(false);
  });

  // Review Focus 1: rows dead-lettered before the text changed still offer the picker.
  it("renders an old dead letter as a pin problem", () => {
    render(<ProblemBadge problem={PIN_UNAVAILABLE_LEGACY} />);
    expect(screen.getByText("Thread archived")).toBeTruthy();
    render(<ThreadProblem problem={PIN_UNAVAILABLE_LEGACY} threadTitle="Platform CI" workspace="user" onPick={vi.fn()} />);
    expect(screen.getByText("Platform CI is archived. Pick another thread:")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pick" })).toBeTruthy();
  });
});

describe("ProblemBadge", () => {
  it("names an archived pin, and renders nothing without a problem", () => {
    const { rerender, container } = render(<ProblemBadge problem={PIN_UNAVAILABLE} />);
    expect(screen.getByText("Thread archived").getAttribute("title")).toBe("The pinned thread is archived. Pick another thread:");
    rerender(<ProblemBadge problem={undefined} />);
    expect(container.textContent).toBe("");
    rerender(<ProblemBadge problem="Something else broke." />);
    expect(screen.getByText("Problem")).toBeTruthy();
  });
});

describe("ThreadProblem", () => {
  it("names the archived thread and passes the pick on", () => {
    const onPick = vi.fn();
    render(<ThreadProblem problem={PIN_UNAVAILABLE} threadTitle="Platform CI" workspace="user" onPick={onPick} />);
    expect(screen.getByText("Platform CI is archived. Pick another thread:")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pick" }));
    expect(onPick).toHaveBeenCalledWith({ mode: "existing", sessionId: "s", threadId: "t" });
  });

  it("names the owner, with no picker, for a viewer who may not change it", () => {
    render(<ThreadProblem problem={PIN_UNAVAILABLE} workspace="user" readOnly onPick={vi.fn()} />);
    expect(screen.getByText("The pinned thread is archived. Pick another thread:")).toBeTruthy();
    expect(screen.getByText("Only its owner can change this.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pick" })).toBeNull();
    expect(screen.queryByText("Select Edit, then choose another option under Where.")).toBeNull();
  });

  it("names who may change it for any problem, not only a pin (S10)", () => {
    render(<ThreadProblem problem="The workflow is gone." workspace="user" readOnly readOnlyText="Only members of SRE can change this." onPick={vi.fn()} />);
    expect(screen.getByText("The workflow is gone.")).toBeTruthy();
    expect(screen.getByText("Only members of SRE can change this.")).toBeTruthy();
  });

  it("names the edit path when no workspace lists threads", () => {
    const { unmount } = render(<ThreadProblem problem={PIN_UNAVAILABLE} workspace={undefined} onPick={vi.fn()} />);
    // A page shows Where under the problem; a row opens it through Edit.
    expect(screen.getByText("Choose another option under Where on this page.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pick" })).toBeNull();
    unmount();
    render(<ThreadProblem problem={PIN_UNAVAILABLE} workspace={undefined} variant="inline" onPick={vi.fn()} />);
    expect(screen.getByText("Select Edit, then choose another option under Where.")).toBeTruthy();
  });

  it("draws a box by default and none inline under a row", () => {
    const { rerender } = render(<ThreadProblem problem={PIN_UNAVAILABLE} workspace="user" onPick={vi.fn()} />);
    expect(screen.getByRole("region", { name: "Problem" }).className).toMatch(/border/);
    rerender(<ThreadProblem problem={PIN_UNAVAILABLE} workspace="user" onPick={vi.fn()} variant="inline" />);
    const inline = screen.getByRole("group", { name: "Problem" });
    expect(inline.className).not.toMatch(/border/);
    expect(inline.className).toMatch(/mt-2/);
    expect(screen.getByRole("button", { name: "Pick" })).toBeTruthy();
  });
});
