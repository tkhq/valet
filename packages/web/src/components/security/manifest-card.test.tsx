// @vitest-environment jsdom
/**
 * Manifest card (valet-security §engagement panel: Manifest). The closed
 * summary, and — on a re-scan — the new/recurring/fixed/dismissed tally line.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import type {
  SecurityCellWire,
  SecurityCostWire,
  SecurityDiffWire,
  SecurityFindingWire,
} from "@valet/api/wire";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
}));

import { ManifestCard } from "./manifest-card";

const cost: SecurityCostWire = { costUsd: 0.42, totalTokens: 1_200_000, priced: true };

const cells: SecurityCellWire[] = [
  {
    id: "cell-1",
    ordinal: 1,
    persona: "code-review",
    mode: "fresh",
    goal: "recon",
    dir: "01-recon",
    reads: [],
    review: false,
    status: "completed",
    attempts: 1,
    compactedAt: null,
    childSessionId: null,
    dispatchedAt: 1,
    settledAt: 2,
    createdAt: 1,
  },
];

function finding(over: Partial<SecurityFindingWire> & { id: string }): SecurityFindingWire {
  return {
    cellId: "cell-1",
    fingerprint: over.id,
    severity: "high",
    title: `Finding ${over.id}`,
    file: "src/a.ts",
    line: 1,
    body: "body",
    status: "open",
    statusReason: null,
    statusActor: null,
    createdAt: 1,
    links: [],
    ...over,
  };
}

const diff: SecurityDiffWire = {
  parentEngagementId: "eng-parent",
  parentSessionId: "s-parent",
  newCount: 2,
  recurringCount: 3,
  fixedCount: 4,
  carriedRefutedCount: 1,
};

describe("ManifestCard", () => {
  it("renders the re-scan tallies on a re-scan manifest", () => {
    render(
      <ManifestCard
        cells={cells}
        findings={[finding({ id: "f-1" })]}
        status="completed"
        cost={cost}
        diff={diff}
        baseRef={"b".repeat(40)}
        changedPaths={["src/a.ts"]}
      />,
    );
    const breakdown = screen.getByLabelText("Re-scan breakdown");
    expect(within(breakdown).getByText("new")).toBeTruthy();
    expect(within(breakdown).getByText("recurring")).toBeTruthy();
    expect(within(breakdown).getByText("fixed")).toBeTruthy();
    expect(within(breakdown).getByText("dismissed")).toBeTruthy();
    expect(breakdown.textContent).toContain("2");
    expect(breakdown.textContent).toContain("3");
    expect(breakdown.textContent).toContain("4");
  });

  it("omits the re-scan tallies on a first review (no diff)", () => {
    render(
      <ManifestCard
        cells={cells}
        findings={[finding({ id: "f-1" })]}
        status="completed"
        cost={cost}
      />,
    );
    expect(screen.queryByLabelText("Re-scan breakdown")).toBeNull();
    expect(screen.queryByLabelText("Re-scan diff")).toBeNull();
  });
});
