// @vitest-environment jsdom
/**
 * Cell rail (valet-security M8, spec §engagement panel): the live progress
 * line, the compaction badge, the yielded badge, the over-age warning past
 * 30 minutes, and the child session link.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import type { SecurityCellWire } from "@valet/api/wire";
import { TooltipProvider } from "~/components/primitives";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
}));

import { CellRail, elapsedLabel, OVER_AGE_MS, progressLine } from "./cell-rail";

function cell(over: Partial<SecurityCellWire> & { id: string }): SecurityCellWire {
  return {
    ordinal: 1,
    persona: "code-review",
    mode: "fresh",
    goal: "recon the tree",
    dir: "01-recon",
    reads: [],
    review: false,
    status: "pending",
    attempts: 1,
    compactedAt: null,
    childSessionId: null,
    dispatchedAt: null,
    settledAt: null,
    createdAt: 1,
    ...over,
  };
}

function renderRail(cells: SecurityCellWire[], onOpenChild?: (id: string) => void) {
  return render(
    <TooltipProvider>
      <CellRail cells={cells} onOpenChild={onOpenChild} />
    </TooltipProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CellRail child link", () => {
  it("opens the child in the slide-over via onOpenChild, not a navigation", () => {
    const onOpenChild = vi.fn();
    renderRail([cell({ id: "c1", status: "running", childSessionId: "child_abc" })], onOpenChild);
    const btn = screen.getByRole("button", { name: "Open 01-recon child session" });
    fireEvent.click(btn);
    expect(onOpenChild).toHaveBeenCalledWith("child_abc");
  });

  it("falls back to a standalone link when no handler is given", () => {
    renderRail([cell({ id: "c1", status: "running", childSessionId: "child_abc" })]);
    // The mocked Link renders an <a> (no button); the label still resolves.
    expect(screen.getByLabelText("Open 01-recon child session").tagName).toBe("A");
    expect(screen.queryByRole("button", { name: "Open 01-recon child session" })).toBeNull();
  });
});

describe("CellRail", () => {
  it("shows the running cell's state-doc progress line", () => {
    renderRail([
      cell({
        id: "c-1",
        status: "running",
        dispatchedAt: Date.now(),
        progress: {
          status: "working",
          checklist: { pending: 33, done: 14 },
          queue: { pending: 3, done: 0 },
        },
      }),
    ]);
    expect(screen.getByText("checklist 14/47 · queue 3 pending")).toBeTruthy();
  });

  it("badges a compacted cell with the checkpoint tooltip copy", () => {
    renderRail([cell({ id: "c-1", status: "running", compactedAt: 123, dispatchedAt: Date.now() })]);
    expect(screen.getByLabelText("Context compacted")).toBeTruthy();
    expect(screen.getByText("compacted")).toBeTruthy();
  });

  it("badges a yielded cell and its attempts past the first", () => {
    renderRail([cell({ id: "c-1", status: "yielded", attempts: 2 })]);
    expect(screen.getByText("yielded")).toBeTruthy();
    expect(screen.getByText("attempt 2")).toBeTruthy();
  });

  it("warns when a cell runs past 30 minutes with no settled child", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00Z"));
    renderRail([
      cell({
        id: "c-over",
        status: "running",
        dispatchedAt: Date.now() - OVER_AGE_MS - 60_000,
      }),
    ]);
    expect(
      screen.getByText("Running over 30 minutes with no settled child. Check the child session."),
    ).toBeTruthy();
  });

  it("does not warn on a fresh running cell", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00Z"));
    renderRail([cell({ id: "c-fresh", status: "running", dispatchedAt: Date.now() - 60_000 })]);
    expect(screen.queryByText(/Running over 30 minutes/)).toBeNull();
    expect(screen.getByText("1m")).toBeTruthy();
  });

  it("links a dispatched cell to its child session", () => {
    renderRail([cell({ id: "c-1", status: "running", childSessionId: "child-9", dispatchedAt: Date.now() })]);
    expect(screen.getByLabelText("Open 01-recon child session")).toBeTruthy();
  });
});

describe("pure helpers", () => {
  it("progressLine formats done/total and pending queue", () => {
    expect(
      progressLine({
        status: "working",
        checklist: { pending: 1, done: 4 },
        queue: { pending: 2, done: 7 },
      }),
    ).toBe("checklist 4/5 · queue 2 pending");
  });

  it("elapsedLabel rolls minutes into hours", () => {
    expect(elapsedLabel(5 * 60_000)).toBe("5m");
    expect(elapsedLabel(72 * 60_000)).toBe("1h 12m");
  });
});
