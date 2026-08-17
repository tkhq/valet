// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TabBar, tabPanelId } from "./tab-bar";

const TABS = [
  { id: "one", label: "One" },
  { id: "two", label: "Two" },
  { id: "three", label: "Three" },
] as const;

describe("TabBar", () => {
  it("marks only the active tab selected, and roves tabindex to it alone", () => {
    render(<TabBar tabs={TABS} active="two" onSelect={vi.fn()} label="Demo" />);
    const two = screen.getByRole("tab", { name: "Two" });
    const one = screen.getByRole("tab", { name: "One" });
    expect(two.getAttribute("aria-selected")).toBe("true");
    expect(one.getAttribute("aria-selected")).toBe("false");
    expect(two.getAttribute("tabindex")).toBe("0");
    expect(one.getAttribute("tabindex")).toBe("-1");
  });

  it("wires aria-controls to the tabPanelId helper", () => {
    render(<TabBar tabs={TABS} active="one" onSelect={vi.fn()} label="Demo" />);
    expect(screen.getByRole("tab", { name: "One" }).getAttribute("aria-controls")).toBe(
      tabPanelId("Demo", "one"),
    );
  });

  it("ArrowRight selects the next tab, wrapping past the end", () => {
    const onSelect = vi.fn();
    render(<TabBar tabs={TABS} active="three" onSelect={onSelect} label="Demo" />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Three" }), { key: "ArrowRight" });
    expect(onSelect).toHaveBeenCalledWith("one");
  });

  it("ArrowLeft selects the previous tab, wrapping before the start", () => {
    const onSelect = vi.fn();
    render(<TabBar tabs={TABS} active="one" onSelect={onSelect} label="Demo" />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "One" }), { key: "ArrowLeft" });
    expect(onSelect).toHaveBeenCalledWith("three");
  });

  it("Home and End jump to the first and last tab", () => {
    const onSelect = vi.fn();
    render(<TabBar tabs={TABS} active="two" onSelect={onSelect} label="Demo" />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Two" }), { key: "End" });
    expect(onSelect).toHaveBeenLastCalledWith("three");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Two" }), { key: "Home" });
    expect(onSelect).toHaveBeenLastCalledWith("one");
  });

  it("click selects the clicked tab", () => {
    const onSelect = vi.fn();
    render(<TabBar tabs={TABS} active="one" onSelect={onSelect} label="Demo" />);
    fireEvent.click(screen.getByRole("tab", { name: "Three" }));
    expect(onSelect).toHaveBeenCalledWith("three");
  });
});
