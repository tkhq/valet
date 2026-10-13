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

  it("hides the group when no row renders", () => {
    function NothingToShow() {
      return null;
    }
    const { container } = render(<Section title="Tools and skills">{false}<NothingToShow /></Section>);
    const group = container.querySelector("section > div:last-child");
    // jsdom applies no CSS. The group is empty, and `empty:hidden` is what
    // keeps an empty grey box off the page.
    expect(group?.childNodes).toHaveLength(0);
    expect(group?.className.split(" ")).toContain("empty:hidden");
  });
});
