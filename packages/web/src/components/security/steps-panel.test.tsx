// @vitest-environment jsdom
/**
 * StepsPanel (spec §engagement panel): collapses to a one-line status strip by
 * default so the findings triage stays readable, expands to the full cell rail
 * on click, and persists the choice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import type { SecurityCellWire } from "@valet/api/wire";
import { TooltipProvider } from "~/components/primitives";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
}));

import { StepsPanel } from "./steps-panel";

function cell(over: Partial<SecurityCellWire> & { id: string }): SecurityCellWire {
  return {
    ordinal: 1,
    persona: "code-review",
    mode: "fresh",
    goal: "map the tree",
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

function renderPanel(cells: SecurityCellWire[]) {
  return render(
    <TooltipProvider>
      <StepsPanel cells={cells} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("StepsPanel", () => {
  it("collapses by default: a status strip with the done/total count, not the goals", () => {
    renderPanel([
      cell({ id: "a", status: "completed", goal: "map the tree" }),
      cell({ id: "b", ordinal: 2, dir: "02-authz", status: "running", goal: "sweep authz" }),
    ]);
    expect(screen.getByText("Steps")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(screen.getByTestId("steps-strip")).toBeTruthy();
    // The running step's dir shows, but not the per-step goals (collapsed).
    expect(screen.getByText("02-authz")).toBeTruthy();
    expect(screen.queryByText("sweep authz")).toBeNull();
  });

  it("expands to the full rail on click and persists the choice", () => {
    renderPanel([cell({ id: "a", goal: "map the tree" })]);
    fireEvent.click(screen.getByRole("button", { name: "Expand steps" }));
    // The rail renders the per-step goal once expanded.
    expect(screen.getByText("map the tree")).toBeTruthy();
    expect(window.localStorage.getItem("valet:sec-steps-expanded")).toBe("1");
  });

  it("starts expanded when the persisted choice says so", () => {
    window.localStorage.setItem("valet:sec-steps-expanded", "1");
    renderPanel([cell({ id: "a", goal: "map the tree" })]);
    expect(screen.getByText("map the tree")).toBeTruthy();
  });
});
