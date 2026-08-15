// @vitest-environment jsdom
/**
 * RiskBadge: maps a riskLevel string to a colour-coded badge.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RiskBadge } from "./risk-badge";

describe("RiskBadge", () => {
  it("renders the level text", () => {
    render(<RiskBadge level="high" />);
    expect(screen.getByText("high")).toBeTruthy();
  });

  it("applies orange class for high", () => {
    const { container } = render(<RiskBadge level="high" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("text-orange-700");
  });

  it("applies amber class for medium", () => {
    const { container } = render(<RiskBadge level="medium" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("text-amber-700");
  });

  it("applies danger class for critical", () => {
    const { container } = render(<RiskBadge level="critical" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("text-danger-600");
  });

  it("applies neutral class for low", () => {
    const { container } = render(<RiskBadge level="low" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("text-neutral-700");
  });

  it("applies neutral class for unknown level", () => {
    const { container } = render(<RiskBadge level="unknown-level" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("text-neutral-700");
  });
});
