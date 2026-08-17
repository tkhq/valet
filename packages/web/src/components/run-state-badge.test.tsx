// @vitest-environment jsdom
/**
 * The point of this component is that five surfaces render the SAME word
 * for the same state. These cases pin the vocabulary, so a surface cannot
 * quietly introduce a sixth spelling of "working".
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SessionRunState } from "@valet/api/wire";
import { RunStateBadge, runStateLabel } from "./run-state-badge";

const ALL: SessionRunState[] = ["needs_you", "working", "failed", "sleeping", "idle"];

describe("RunStateBadge", () => {
  it("renders a label for every state in the union", () => {
    for (const state of ALL) {
      const { unmount } = render(<RunStateBadge state={state} />);
      expect(screen.getByText(runStateLabel(state))).toBeTruthy();
      unmount();
    }
  });

  it("names the person, not the mechanism, when a decision is pending", () => {
    render(<RunStateBadge state="needs_you" />);
    expect(screen.getByText("Needs you")).toBeTruthy();
  });

  it("gives only the working state a pulsing dot", () => {
    const { container, unmount } = render(<RunStateBadge state="working" />);
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
    // The pulse must not survive a reduced-motion preference.
    expect(container.querySelector(".motion-reduce\\:animate-none")).toBeTruthy();
    unmount();

    for (const state of ALL.filter((s) => s !== "working")) {
      const { container: c, unmount: u } = render(<RunStateBadge state={state} />);
      expect(c.querySelector(".animate-pulse")).toBeNull();
      u();
    }
  });

  it("uses one spelling per state across the chip and the bare label", () => {
    for (const state of ALL) {
      const { unmount } = render(<RunStateBadge state={state} />);
      // The chip's text and `runStateLabel` must never diverge — that is the
      // drift this component exists to prevent.
      expect(screen.getByText(runStateLabel(state))).toBeTruthy();
      unmount();
    }
  });
});
