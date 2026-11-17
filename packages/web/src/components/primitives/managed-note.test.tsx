// @vitest-environment jsdom
/** `ManagedNote`: one line per scope, with the optional admin step. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedNote } from "./managed-note";

afterEach(cleanup);

describe("ManagedNote", () => {
  it("names the organization or the team", () => {
    render(<><ManagedNote scope="org" /><ManagedNote scope="team" /></>);
    expect(screen.getByText("Managed by your organization.")).toBeTruthy();
    expect(screen.getByText("Managed by your team.")).toBeTruthy();
  });

  it("adds the admin step on request", () => {
    render(<ManagedNote scope="org" askAdmin />);
    expect(screen.getByText("Managed by your organization. Ask an admin to change it.")).toBeTruthy();
  });

  it("hides the lock icon from assistive technology", () => {
    const { container } = render(<ManagedNote scope="team" />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});
