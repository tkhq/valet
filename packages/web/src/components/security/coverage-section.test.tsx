// @vitest-environment jsdom
/**
 * Coverage-honesty section (NOT_ASSESSED ledger, M-P2d, spec §Coverage
 * honesty): summary counts, a tab per status, and pagination. It defaults to
 * the actionable gaps tab, lists each gap with its reason, and renders nothing
 * when no coverage was recorded.
 */
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SecurityCoverageWire } from "@valet/api/wire";
import { CoverageSection } from "./coverage-section";

function cov(over: Partial<SecurityCoverageWire> & { id: string }): SecurityCoverageWire {
  return {
    cellId: "c1",
    area: "area",
    status: "assessed",
    tool: null,
    reason: null,
    createdAt: 1,
    ...over,
  };
}

describe("CoverageSection", () => {
  it("shows the counts and defaults to the gaps tab with each gap's reason", () => {
    const coverage = [
      cov({ id: "1", area: "secrets scan", status: "assessed", tool: "gitleaks" }),
      cov({ id: "2", area: "sast pack", status: "assessed" }),
      cov({ id: "3", area: "auth", status: "assessed" }),
      cov({
        id: "4",
        area: "semgrep owasp",
        status: "not_assessed",
        tool: "semgrep",
        reason: "OWASP sink rules not scanned because semgrep is missing.",
      }),
    ];
    render(<CoverageSection coverage={coverage} cells={[]} />);
    expect(screen.getByText(/3 assessed/)).toBeTruthy();
    expect(screen.getByText(/1 not assessed/)).toBeTruthy();
    // Defaults to gaps: the gap area + reason render; assessed rows are hidden.
    expect(screen.getByText("semgrep owasp")).toBeTruthy();
    expect(screen.getByText(/OWASP sink rules not scanned/)).toBeTruthy();
    expect(screen.queryByText("secrets scan")).toBeNull();

    // Switching to the Assessed tab shows the assessed areas.
    fireEvent.click(screen.getByRole("button", { name: /Assessed 3/ }));
    expect(screen.getByText("secrets scan")).toBeTruthy();
    expect(screen.queryByText("semgrep owasp")).toBeNull();
  });

  it("paginates a long list within a tab", () => {
    const coverage = Array.from({ length: 7 }, (_, i) =>
      cov({ id: `g${i}`, area: `gap ${i}`, status: "not_assessed", reason: `reason ${i}` }),
    );
    render(<CoverageSection coverage={coverage} cells={[]} />);
    // Page 1 of 2: first five gaps, not the sixth.
    expect(screen.getByText("gap 0")).toBeTruthy();
    expect(screen.queryByText("gap 5")).toBeNull();
    expect(screen.getByText(/1–5 of 7/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("gap 5")).toBeTruthy();
    expect(screen.queryByText("gap 0")).toBeNull();
  });

  it("renders nothing when no coverage was recorded", () => {
    const { container } = render(<CoverageSection coverage={[]} cells={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("defaults to the assessed tab when there are no gaps", () => {
    const coverage = [cov({ id: "1", area: "secrets scan", status: "assessed", tool: "gitleaks" })];
    render(<CoverageSection coverage={coverage} cells={[]} />);
    expect(screen.getByText(/1 assessed/)).toBeTruthy();
    expect(screen.getByText("secrets scan")).toBeTruthy();
    expect(screen.queryByText(/No coverage gaps/)).toBeNull();
  });
});
