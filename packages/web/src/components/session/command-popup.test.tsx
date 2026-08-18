// @vitest-environment jsdom
/**
 * CommandPopup: grouped suggestion popup (slash commands + argument
 * completions). Tests the pure component plus the `commandsToItems` adapter.
 * Keyboard handling (arrows/Enter/Esc) lives in the composer and is covered
 * by composer.test.tsx; the popup itself delegates via onMouseDown/onMouseMove.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { WireCommandInfo } from "@valet/api/wire";
import { CommandPopup, commandsToItems, type PopupItem } from "./command-popup";

const FIXTURE: WireCommandInfo[] = [
  { name: "status", description: "Show session status", source: "builtin" },
  { name: "stop", description: "Stop the agent", source: "builtin" },
  { name: "skill:review", description: "Run code review", source: "skill" },
];

function renderPopup(
  items: PopupItem[],
  selectedIndex = 0,
  onSelect = vi.fn(),
  onHover = vi.fn(),
  notice?: string,
) {
  return render(
    <CommandPopup
      items={items}
      notice={notice}
      ariaLabel="test suggestions"
      selectedIndex={selectedIndex}
      onSelect={onSelect}
      onHover={onHover}
    />,
  );
}

describe("commandsToItems", () => {
  it("maps commands to slash-prefixed items grouped by source", () => {
    const items = commandsToItems(FIXTURE);
    expect(items.map((i) => i.label)).toEqual(["/status", "/stop", "/skill:review"]);
    expect(items.map((i) => i.group)).toEqual(["Built-in", "Built-in", "Skill"]);
    expect(items[0].id).toBe("status");
  });

  it("carries argHint into the item hint", () => {
    const items = commandsToItems([
      { name: "model", description: "Switch model", source: "builtin", argHint: "[model-id]" },
    ]);
    expect(items[0].hint).toBe("[model-id]");
  });

  it("floats the group of the most recently used command to the top", () => {
    // skill:review was used more recently than any builtin — the whole
    // Skill group rises above Built-in, and groups stay contiguous.
    const items = commandsToItems(FIXTURE, { "skill:review": 2000, status: 1000 });
    expect(items.map((i) => i.label)).toEqual(["/skill:review", "/status", "/stop"]);
    expect(items.map((i) => i.group)).toEqual(["Skill", "Built-in", "Built-in"]);
  });

  it("orders commands inside a group by recency, never-used last", () => {
    const items = commandsToItems(FIXTURE, { stop: 500 });
    // Both builtins beat the never-used skill group only by default order;
    // within Built-in, stop (used) beats status (never used).
    expect(items.map((i) => i.label)).toEqual(["/stop", "/status", "/skill:review"]);
  });

  it("keeps groups contiguous when two groups share one max stamp", () => {
    // status (builtin) and skill:review (skill) were used in the same ms —
    // the group tie falls through to SOURCE_ORDER, so Built-in stays whole
    // and ahead of Skill instead of interleaving.
    const items = commandsToItems(FIXTURE, { status: 1000, "skill:review": 1000 });
    expect(items.map((i) => i.group)).toEqual(["Built-in", "Built-in", "Skill"]);
    expect(items.map((i) => i.label)).toEqual(["/status", "/stop", "/skill:review"]);
  });

  it("keeps the default source order with no recency", () => {
    const items = commandsToItems(FIXTURE, {});
    expect(items.map((i) => i.label)).toEqual(["/status", "/stop", "/skill:review"]);
  });
});

describe("CommandPopup — rendering", () => {
  it("renders only the passed items", () => {
    const filtered = commandsToItems(FIXTURE.filter((c) => c.name.startsWith("sta")));
    renderPopup(filtered);
    expect(screen.getByText("/status")).toBeTruthy();
    expect(screen.queryByText("/stop")).toBeNull();
    expect(screen.queryByText("/skill:review")).toBeNull();
  });

  it("renders group headers in first-appearance order", () => {
    renderPopup(commandsToItems(FIXTURE));
    expect(screen.getByText("Built-in")).toBeTruthy();
    expect(screen.getByText("Skill")).toBeTruthy();
  });

  it("does not render a header for absent groups", () => {
    renderPopup(commandsToItems(FIXTURE.filter((c) => c.source === "builtin")));
    expect(screen.queryByText("Skill")).toBeNull();
  });

  it("renders argument items with value, label, and group", () => {
    renderPopup([
      { id: "claude-opus-4-8", label: "claude-opus-4-8", detail: "Opus 4.8", group: "Arguments" },
    ]);
    expect(screen.getByText("Arguments")).toBeTruthy();
    expect(screen.getByText("claude-opus-4-8")).toBeTruthy();
    expect(screen.getByText("Opus 4.8")).toBeTruthy();
  });

  it("renders a passive notice row when no items match", () => {
    renderPopup([], 0, vi.fn(), vi.fn(), "[instructions]");
    expect(screen.getByTestId("popup-notice").textContent).toBe("[instructions]");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("renders nothing with no items and no notice", () => {
    const { container } = renderPopup([]);
    expect(container.firstChild).toBeNull();
  });
});

describe("CommandPopup — selection", () => {
  it("fires onSelect with the item id on mousedown", () => {
    const onSelect = vi.fn();
    renderPopup(commandsToItems(FIXTURE.filter((c) => c.name.startsWith("sta"))), 0, onSelect);
    fireEvent.mouseDown(screen.getByRole("option", { name: /status/i }));
    expect(onSelect).toHaveBeenCalledWith("status");
  });

  it("marks selectedIndex row as aria-selected", () => {
    renderPopup(commandsToItems(FIXTURE), 1);
    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("false");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
  });

  it("fires onHover with the row's flat index on pointer move", () => {
    const onHover = vi.fn();
    renderPopup(commandsToItems(FIXTURE), 0, vi.fn(), onHover);
    const options = screen.getAllByRole("option");
    fireEvent.mouseMove(options[1]);
    expect(onHover).toHaveBeenCalledWith(1);
    // Moving over the already-selected row does not re-fire.
    onHover.mockClear();
    fireEvent.mouseMove(options[0]);
    expect(onHover).not.toHaveBeenCalled();
  });
});
