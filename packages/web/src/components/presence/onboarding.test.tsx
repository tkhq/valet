// @vitest-environment jsdom
/**
 * The onboarding empty state (docs/specs/2026-10-16-presence-hub-design.md
 * Part B step 9): with no place and no routine, the overview names where to start.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => <a className={className} href={to}>{children}</a>,
}));
vi.mock("~/components/events/automation-wizard", () => ({
  AutomationWizard: ({ startOn }: { startOn?: string }) => <p>{startOn === "routine" ? "New routine dialog" : "Other dialog"}</p>,
}));

import { Onboarding } from "./onboarding";

afterEach(cleanup);

describe("Onboarding", () => {
  it("names the state and links each service to Integrations", () => {
    render(<Onboarding />);
    expect(screen.getByRole("heading", { level: 3, name: "Valet is not present anywhere yet." })).toBeTruthy();
    for (const name of ["Connect Slack", "Connect GitHub", "Connect Linear"]) {
      expect(screen.getByRole("link", { name: new RegExp(`^${name}`) }).getAttribute("href")).toBe("/integrations");
    }
  });

  it("opens the wizard on When from Add", () => {
    render(<Onboarding />);
    expect(screen.getByText(/^or/).textContent).toBe("or Add to listen somewhere, or run on a schedule.");
    expect(screen.queryByText("Other dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("Other dialog")).toBeTruthy();
  });
});
