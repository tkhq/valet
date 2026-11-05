// @vitest-environment jsdom
/**
 * The onboarding empty state (docs/specs/2026-10-16-presence-hub-design.md
 * Part B step 9): with no place and no routine, two paragraphs say where to
 * start, with Slack, GitHub, and Linear as links to Integrations. The
 * overview's header carries Add, so the paragraphs hold none.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => <a className={className} href={to}>{children}</a>,
}));

import { Onboarding } from "./onboarding";

afterEach(cleanup);

const COPY = "Choose Add to have Valet act on a schedule. To have it listen somewhere too, connect Slack, GitHub, or Linear and Add again.";

describe("Onboarding", () => {
  it("names the state in two paragraphs and links each service to Integrations", () => {
    render(<Onboarding />);
    expect(screen.getByText("Valet is not present anywhere yet.").tagName).toBe("P");
    const quiet = screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === COPY);
    expect(quiet.className).toContain("text-muted");
    for (const name of ["Slack", "GitHub", "Linear"]) {
      expect(screen.getByRole("link", { name }).getAttribute("href")).toBe("/integrations");
    }
    expect(screen.queryByRole("link", { name: /^Connect/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });
});
