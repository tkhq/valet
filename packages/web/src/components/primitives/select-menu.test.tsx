// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SelectMenu } from "./select-menu";

describe("SelectMenu", () => {
  it("shows the selected option's label on the trigger", () => {
    render(
      <SelectMenu
        value="b"
        onChange={vi.fn()}
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "Beta" })).toBeTruthy();
  });

  it("falls back to the raw value when no option matches", () => {
    render(<SelectMenu value="missing" onChange={vi.fn()} options={[{ value: "a", label: "Alpha" }]} />);
    expect(screen.getByRole("button", { name: "missing" })).toBeTruthy();
  });

  it("calls onChange with the picked option's value", () => {
    const onChange = vi.fn();
    render(
      <SelectMenu
        value="a"
        onChange={onChange}
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ]}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Alpha" }), { key: "Enter" });
    fireEvent.click(screen.getByText("Beta"));
    expect(onChange).toHaveBeenCalledWith("b");
  });
});
