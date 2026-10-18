// @vitest-environment jsdom
/** The on/off switch: the default size, and the small size the Presence roster uses. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Switch } from "./switch";

afterEach(cleanup);

function thumbOf(control: HTMLElement): HTMLElement {
  const thumb = control.firstElementChild;
  if (!(thumb instanceof HTMLElement)) throw new Error("The switch has no thumb.");
  return thumb;
}

describe("Switch", () => {
  it("keeps the default size for every existing caller", () => {
    render(<Switch checked onCheckedChange={() => {}} aria-label="On" />);
    const control = screen.getByRole("switch", { name: "On" });
    expect(control.classList.contains("h-5")).toBe(true);
    expect(control.classList.contains("w-9")).toBe(true);
    expect(thumbOf(control).classList.contains("h-3.5")).toBe(true);
    expect(thumbOf(control).classList.contains("translate-x-[18px]")).toBe(true);
  });

  it("draws the small size at 28 by 16 with a 12px thumb", () => {
    render(
      <>
        <Switch size="sm" checked onCheckedChange={() => {}} aria-label="Small on" />
        <Switch size="sm" checked={false} onCheckedChange={() => {}} aria-label="Small off" />
      </>,
    );
    const on = screen.getByRole("switch", { name: "Small on" });
    expect(on.classList.contains("h-4")).toBe(true);
    expect(on.classList.contains("w-7")).toBe(true);
    expect(on.classList.contains("w-9")).toBe(false);
    expect(thumbOf(on).classList.contains("h-3")).toBe(true);
    expect(thumbOf(on).classList.contains("w-3")).toBe(true);
    expect(thumbOf(on).classList.contains("translate-x-[14px]")).toBe(true);
    expect(thumbOf(screen.getByRole("switch", { name: "Small off" })).classList.contains("translate-x-[2px]")).toBe(true);
  });
});
