// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Select } from "./input";

describe("Select", () => {
  it("uses the default field size and keeps its accessible name", () => {
    render(
      <Select aria-label="Mode" className="w-full" defaultValue="b">
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>,
    );
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Mode" });
    expect(select.className).toContain("h-9");
    expect(select.className).toContain("text-sm");
    expect(select.className).toContain("focus-visible:ring-2");
    expect(select.className).toContain("w-full");
    expect(select.value).toBe("b");
  });

  it("uses the compact size for size=\"sm\"", () => {
    render(
      <Select aria-label="Scope" size="sm">
        <option value="a">A</option>
      </Select>,
    );
    const select = screen.getByRole("combobox", { name: "Scope" });
    expect(select.className).toContain("h-8");
    expect(select.className).toContain("text-xs");
    expect(select.className).not.toContain("h-9");
    expect(select.hasAttribute("size")).toBe(false);
  });
});
