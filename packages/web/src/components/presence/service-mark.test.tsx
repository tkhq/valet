// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ServiceMark } from "./service-mark";

describe("ServiceMark", () => {
  it("draws each service on its tinted tile at the asked size", () => {
    const { container } = render(
      <>
        <ServiceMark service="slack" size="sm" />
        <ServiceMark service="github" size="md" />
        <ServiceMark service="linear" size="lg" />
        <ServiceMark service="schedule" size="lg" />
      </>,
    );
    const tiles = [...container.querySelectorAll<HTMLElement>("[data-service]")];
    expect(tiles.map((t) => [t.dataset.service, t.style.width, t.querySelector("svg")?.style.width])).toEqual([
      ["slack", "16px", "10px"],
      ["github", "24px", "14px"],
      ["linear", "28px", "16px"],
      ["schedule", "28px", "16px"],
    ]);
    expect(tiles[0]?.style.background).toContain("oklch(0.55 0.12 320 / 0.14)");
    expect(tiles[0]?.style.color).toContain("oklch(0.45 0.14 320)");
    expect(tiles[2]?.style.background).toContain("oklch(0.55 0.14 275 / 0.16)");
    // GitHub and Linear draw the simple-icons path; Slack draws the hash.
    expect(tiles[1]?.querySelector("path")?.getAttribute("d")).toMatch(/^M12 \.297/);
    expect(tiles[0]?.querySelector("path")?.getAttribute("d")).toBe("M9 3v18M15 3v18M3 9h18M3 15h18");
    expect(tiles[3]?.querySelector("circle")).not.toBeNull();
  });

  it("hides a mark beside its name and names one that stands alone", () => {
    const { container, getByRole } = render(
      <>
        <ServiceMark service="github" />
        <ServiceMark service="linear" label="Linear" />
      </>,
    );
    expect(container.querySelector("[data-service=github]")?.getAttribute("aria-hidden")).toBe("true");
    expect(getByRole("img", { name: "Linear" })).toBeTruthy();
  });
});
