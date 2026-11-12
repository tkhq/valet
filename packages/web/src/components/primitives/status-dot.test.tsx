// @vitest-environment jsdom
/** `StatusDot`: the tone classes, and the label that makes it an image. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusDot } from "./status-dot";

afterEach(cleanup);

describe("StatusDot", () => {
  it("paints the success tone green, not the palette accent", () => {
    // `bg-moss` is blue on the default palette, so a success dot read as `info`.
    render(<StatusDot tone="success" label="Connected" />);
    const dot = screen.getByRole("img", { name: "Connected" });
    expect(dot.classList.contains("bg-success-500")).toBe(true);
    expect(dot.classList.contains("bg-moss")).toBe(false);
  });

  it("is hidden from assistive technology without a label", () => {
    const { container } = render(<StatusDot tone="danger" />);
    const dot = container.firstElementChild;
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(dot?.getAttribute("role")).toBeNull();
    expect(dot?.classList.contains("bg-danger-500")).toBe(true);
  });
});
