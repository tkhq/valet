// @vitest-environment jsdom
/**
 * Re-scan diff banner (valet-security, re-scan / iterate). The tallies, the
 * fixed-count deferral while running, the empty-diff copy, and the scoped /
 * full-re-scan scope lines.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import type { SecurityDiffWire } from "@valet/api/wire";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
}));

import { RescanDiffBanner } from "./rescan-diff";

function diff(over?: Partial<SecurityDiffWire>): SecurityDiffWire {
  return {
    parentEngagementId: "eng-parent",
    parentSessionId: "s-parent",
    newCount: 0,
    recurringCount: 0,
    fixedCount: null,
    carriedRefutedCount: 0,
    ...over,
  };
}

describe("RescanDiffBanner", () => {
  it("renders the changed-files scope line with the new/recurring/fixed tallies", () => {
    render(
      <RescanDiffBanner
        diff={diff({ newCount: 3, recurringCount: 5, fixedCount: 2 })}
        terminal
        baseRef={"b".repeat(40)}
        changedPaths={["src/a.ts", "src/b.ts"]}
      />,
    );
    const banner = screen.getByLabelText("Re-scan diff");
    expect(banner.textContent).toContain("3 new");
    expect(banner.textContent).toContain("5 recurring");
    expect(banner.textContent).toContain("2 fixed");
    expect(banner.textContent).toContain("Scoped to 2 changed files since bbbbbbbbbbbb");
  });

  it("renders the empty-diff copy when no files changed since the parent", () => {
    render(
      <RescanDiffBanner
        diff={diff({ newCount: 0, recurringCount: 4, fixedCount: 1 })}
        terminal
        baseRef={"c".repeat(40)}
        changedPaths={[]}
      />,
    );
    const banner = screen.getByLabelText("Re-scan diff");
    // Carried = recurring + fixed = 5; 0 new.
    expect(banner.textContent).toContain(
      "No changes since the last review — carried 5 findings, re-checked, 0 new.",
    );
    // The empty-diff copy is distinct from the scoped / full-re-scan lines.
    expect(banner.textContent).not.toContain("Scoped to");
    expect(banner.textContent).not.toContain("Full re-scan");
  });

  it("defers the fixed count while the scan runs", () => {
    render(
      <RescanDiffBanner
        diff={diff({ newCount: 1, recurringCount: 2 })}
        terminal={false}
        baseRef={"d".repeat(40)}
        changedPaths={["src/a.ts"]}
      />,
    );
    const banner = screen.getByLabelText("Re-scan diff");
    expect(banner.textContent).toContain("fixed count after it finishes");
    expect(banner.textContent).not.toMatch(/\bfixed\b(?!\s*count)/);
  });

  it("falls back to the full-re-scan line when no diff was captured", () => {
    render(
      <RescanDiffBanner
        diff={diff({ newCount: 1 })}
        terminal
        baseRef={null}
        changedPaths={null}
      />,
    );
    const banner = screen.getByLabelText("Re-scan diff");
    expect(banner.textContent).toContain("Full re-scan (prior commit unavailable)");
  });
});
