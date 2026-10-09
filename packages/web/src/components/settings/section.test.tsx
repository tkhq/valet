// @vitest-environment jsdom
/** A section under a route tab of the same name does not print the name twice. */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActiveTabLabel, Section } from "./section";

describe("Section", () => {
  it("keeps a heading that repeats the active tab for screen readers only", () => {
    render(
      <ActiveTabLabel.Provider value="Plugins">
        <Section title="Plugins">rows</Section>
        <Section title="Providers">rows</Section>
      </ActiveTabLabel.Provider>,
    );
    expect(screen.getByRole("heading", { name: "Plugins" }).className).toBe("sr-only");
    expect(screen.getByRole("heading", { name: "Providers" }).className).not.toContain("sr-only");
  });

  it("shows the heading outside a tab", () => {
    render(<Section title="Plugins">rows</Section>);
    expect(screen.getByRole("heading", { name: "Plugins" }).className).not.toContain("sr-only");
  });
});
