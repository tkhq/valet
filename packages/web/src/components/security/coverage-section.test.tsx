// @vitest-environment jsdom
/**
 * Coverage-honesty section (NOT_ASSESSED ledger, M-P2d, spec §Coverage
 * honesty): it renders the assessed/not_assessed rollup and lists every
 * NOT_ASSESSED gap with its reason, and renders nothing when no coverage was
 * recorded.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SecurityCoverageRollupWire } from "@valet/api/wire";
import { CoverageSection } from "./coverage-section";

describe("CoverageSection", () => {
  it("shows the assessed/not_assessed counts and lists each gap with its reason", () => {
    const rollup: SecurityCoverageRollupWire = {
      assessed: 3,
      notAssessed: 1,
      gaps: [
        {
          area: "semgrep owasp",
          tool: "semgrep",
          reason: "OWASP sink rules not scanned because semgrep is missing.",
        },
      ],
    };
    render(<CoverageSection rollup={rollup} />);
    expect(screen.getByText(/3 assessed/)).toBeTruthy();
    expect(screen.getByText(/1 not assessed/)).toBeTruthy();
    expect(screen.getByText(/Not assessed: semgrep owasp/)).toBeTruthy();
    expect(
      screen.getByText(/OWASP sink rules not scanned because semgrep is missing\./),
    ).toBeTruthy();
  });

  it("renders nothing when no coverage was recorded", () => {
    const rollup: SecurityCoverageRollupWire = { assessed: 0, notAssessed: 0, gaps: [] };
    const { container } = render(<CoverageSection rollup={rollup} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the counts with no gap list when everything was assessed", () => {
    const rollup: SecurityCoverageRollupWire = { assessed: 5, notAssessed: 0, gaps: [] };
    render(<CoverageSection rollup={rollup} />);
    expect(screen.getByText(/5 assessed/)).toBeTruthy();
    expect(screen.queryByText(/Not assessed:/)).toBeNull();
  });
});
