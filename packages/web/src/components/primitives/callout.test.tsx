// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Callout } from "./callout";

describe("Callout", () => {
  it("defaults to the neutral tone on a div", () => {
    render(<Callout>Saved</Callout>);
    const box = screen.getByText("Saved");
    expect(box.tagName).toBe("DIV");
    expect(box.className).toContain("border-line");
    expect(box.className).toContain("bg-ink-wash");
  });

  it.each([
    ["warning", "bg-warning-wash"],
    ["danger", "bg-danger-wash"],
    ["success", "bg-success-wash"],
  ] as const)("uses the %s wash", (tone, wash) => {
    render(<Callout tone={tone}>{tone}</Callout>);
    expect(screen.getByText(tone).className).toContain(wash);
  });

  it("keeps the role it is given", () => {
    render(<Callout role="alert" tone="danger">Could not save</Callout>);
    expect(screen.getByRole("alert").textContent).toBe("Could not save");
  });

  it("puts its classes on the child with asChild", () => {
    render(
      <Callout asChild tone="danger" className="grid gap-1">
        <ul role="alert"><li>One</li></ul>
      </Callout>,
    );
    const list = screen.getByRole("alert");
    expect(list.tagName).toBe("UL");
    expect(list.className).toContain("bg-danger-wash");
    expect(list.className).toContain("grid");
  });
});
