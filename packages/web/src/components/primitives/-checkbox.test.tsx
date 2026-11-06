// @vitest-environment jsdom
/**
 * `Checkbox` primitive: exposes `role="checkbox"` with `aria-checked`, fires
 * `onCheckedChange` with the toggled value, and blocks the callback when
 * disabled.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Checkbox } from "./checkbox";

describe("Checkbox", () => {
  it("renders the checked state via aria-checked", () => {
    render(<Checkbox checked onCheckedChange={() => {}} aria-label="Platform" />);
    expect(screen.getByRole("checkbox", { name: "Platform" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("outlines an unchecked box in control-border and fills a checked one with moss", () => {
    render(
      <>
        <Checkbox checked={false} onCheckedChange={() => {}} aria-label="Unchecked" />
        <Checkbox checked onCheckedChange={() => {}} aria-label="Checked" />
      </>,
    );
    const unchecked = screen.getByRole("checkbox", { name: "Unchecked" });
    expect(unchecked.getAttribute("aria-checked")).toBe("false");
    expect(unchecked.classList.contains("border-control-border")).toBe(true);
    expect(unchecked.classList.contains("border-line")).toBe(false);
    expect(unchecked.querySelector("svg")).toBeNull();

    const checked = screen.getByRole("checkbox", { name: "Checked" });
    expect(checked.getAttribute("aria-checked")).toBe("true");
    expect(checked.classList.contains("bg-moss")).toBe(true);
    expect(checked.classList.contains("text-on-moss")).toBe(true);
    expect(checked.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("fires onCheckedChange with the toggled value", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Checkbox checked={false} onCheckedChange={onCheckedChange} aria-label="Platform" />);

    await user.click(screen.getByRole("checkbox", { name: "Platform" }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("toggles from checked back to unchecked", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Checkbox checked onCheckedChange={onCheckedChange} aria-label="Platform" />);

    await user.click(screen.getByRole("checkbox", { name: "Platform" }));
    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it("does not fire onCheckedChange when disabled", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <Checkbox checked={false} disabled onCheckedChange={onCheckedChange} aria-label="Platform" />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Platform" }));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
