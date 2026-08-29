// @vitest-environment jsdom
/**
 * Severity + status marks (valet-security). The `fixed` status chip (re-scan
 * v2) must render distinct from the other three statuses.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { SecurityFindingStatus } from "@valet/api/wire";
import { FindingStatusChip } from "./severity";

describe("FindingStatusChip", () => {
  it("renders every status, including the re-scan `fixed` chip", () => {
    const statuses: SecurityFindingStatus[] = ["open", "verified", "refuted", "fixed"];
    for (const status of statuses) {
      const { container, unmount } = render(<FindingStatusChip status={status} />);
      expect(container.textContent).toContain(status);
      unmount();
    }
  });

  it("gives `fixed` a distinct, calm-positive treatment (not `verified`)", () => {
    const { container: fixed } = render(<FindingStatusChip status="fixed" />);
    const { container: verified } = render(<FindingStatusChip status="verified" />);
    const fixedChip = fixed.querySelector("span");
    const verifiedChip = verified.querySelector("span");
    expect(fixedChip).not.toBeNull();
    expect(verifiedChip).not.toBeNull();
    // Both ride the success tokens, but `fixed` is outlined (a ring) so it
    // reads apart from the filled `verified` pill.
    expect(fixedChip?.className).toContain("ring-1");
    expect(verifiedChip?.className).not.toContain("ring-1");
    // A leading check mark carries the "resolved" read.
    expect(fixed.querySelector("svg")).not.toBeNull();
    expect(verified.querySelector("svg")).toBeNull();
  });
});
