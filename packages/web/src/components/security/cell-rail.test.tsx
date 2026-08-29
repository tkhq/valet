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

import {
  CellRail,
  elapsedLabel,
  OVER_AGE_MS,
  phaseKey,
  progressLine,
  triadRole,
} from "./cell-rail";

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

describe("CellRail triad grouping (M-P2b)", () => {
  // The three rows of an expanded authz triad, plus recon and verify.
  const triadCells = [
    cell({ id: "recon", ordinal: 1, dir: "01-recon", persona: "code-review", goal: "map" }),
    cell({ id: "ap", ordinal: 2, dir: "02-authz-sweep-plan", persona: "architect", goal: "plan authz" }),
    cell({ id: "aw", ordinal: 3, dir: "03-authz-sweep", persona: "code-review", goal: "sweep authz" }),
    cell({ id: "av", ordinal: 4, dir: "04-authz-sweep-verify", persona: "verifier", goal: "verify authz", review: true }),
    cell({ id: "verify", ordinal: 5, dir: "05-verify", persona: "code-review", goal: "attack", review: true }),
  ];

  it("badges the architect and verifier cells by role", () => {
    renderRail(triadCells);
    // The architect and verifier rows show a role badge instead of the persona.
    expect(screen.getByLabelText("architect cell")).toBeTruthy();
    expect(screen.getByLabelText("verifier cell")).toBeTruthy();
  });

  it("draws a shared left rail on a triad phase's rows, not on single cells", () => {
    const { container } = renderRail(triadCells);
    const rows = container.querySelectorAll("li");
    // The three authz rows (indices 1-3) group; recon (0) and verify (4) do not.
    expect(rows[1].className).toContain("border-l-line");
    expect(rows[2].className).toContain("border-l-line");
    expect(rows[3].className).toContain("border-l-line");
    expect(rows[0].className).not.toContain("border-l-line");
    expect(rows[4].className).not.toContain("border-l-line");
  });
});

describe("pure helpers", () => {
  it("triadRole maps architect/verifier personas, null otherwise", () => {
    expect(triadRole("architect")).toBe("architect");
    expect(triadRole("verifier")).toBe("verifier");
    expect(triadRole("code-review")).toBeNull();
  });

  it("phaseKey strips the ordinal prefix and the -plan/-verify suffix", () => {
    expect(phaseKey("02-authz-sweep-plan")).toBe("authz-sweep");
    expect(phaseKey("03-authz-sweep")).toBe("authz-sweep");
    expect(phaseKey("04-authz-sweep-verify")).toBe("authz-sweep");
    expect(phaseKey("01-recon")).toBe("recon");
    expect(phaseKey("05-verify")).toBe("verify");
  });

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
