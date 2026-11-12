// @vitest-environment jsdom
/** `RadioCard`: the selected and unselected looks, and its radio semantics. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RadioCard } from "./radio-card";

afterEach(cleanup);

describe("RadioCard", () => {
  it("marks the selected card with a moss border and wash, and no ring", () => {
    render(
      <div role="radiogroup" aria-label="Theme">
        <RadioCard title="Dark" description="Low-glare surfaces." selected onSelect={vi.fn()} />
        <RadioCard title="Light" description="Bright surfaces." selected={false} onSelect={vi.fn()} />
      </div>,
    );
    const selected = screen.getByRole("radio", { name: "Dark Low-glare surfaces." });
    expect(selected.getAttribute("aria-checked")).toBe("true");
    expect(selected.classList.contains("border-moss")).toBe(true);
    expect(selected.classList.contains("bg-moss-wash")).toBe(true);
    // The base page fill gives way to the wash.
    expect(selected.classList.contains("bg-[--bg]")).toBe(false);
    expect(selected.className).not.toMatch(/(^|\s)ring-1(\s|$)/);
    expect(screen.getByText("Dark").classList.contains("text-moss-text")).toBe(true);

    const other = screen.getByRole("radio", { name: "Light Bright surfaces." });
    expect(other.getAttribute("aria-checked")).toBe("false");
    expect(other.classList.contains("border-line")).toBe(true);
    expect(other.classList.contains("bg-moss-wash")).toBe(false);
    expect(screen.getByText("Light").classList.contains("text-ink")).toBe(true);
  });

  it("calls onSelect when clicked", () => {
    const onSelect = vi.fn();
    render(<RadioCard title="Tide" description="Teal on sea grey." selected={false} onSelect={onSelect} />);
    screen.getByRole("radio", { name: "Tide Teal on sea grey." }).click();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
