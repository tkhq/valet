// @vitest-environment jsdom
/**
 * CommandPopup: filtered autocomplete popup for slash commands.
 *
 * Tests cover: prefix filtering (caller responsibility, but we verify render),
 * Enter fires onSelect, Esc is handled in the composer (keyboard handler).
 * (popup itself delegates via onMouseDown). We test the pure component directly.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { CommandInfo } from "@valet/api/wire";
import { CommandPopup } from "./command-popup";

const FIXTURE: CommandInfo[] = [
  { name: "status", description: "Show session status", source: "builtin" },
  { name: "stop", description: "Stop the agent", source: "builtin" },
  { name: "skill:review", description: "Run code review", source: "skill" },
];

function renderPopup(
  commands: CommandInfo[],
  query: string,
  selectedIndex = 0,
  onSelect = vi.fn(),
  onHover = vi.fn(),
) {
  return render(
    <CommandPopup
      commands={commands}
      query={query}
      selectedIndex={selectedIndex}
      onSelect={onSelect}
      onHover={onHover}
    />,
  );
}

describe("CommandPopup — filtering", () => {
  it("renders only matching commands when caller passes filtered list", () => {
    const filtered = FIXTURE.filter((c) => c.name.startsWith("sta"));
    renderPopup(filtered, "sta");
    expect(screen.getByText("/status")).toBeTruthy();
    expect(screen.queryByText("/stop")).toBeNull();
    expect(screen.queryByText("/skill:review")).toBeNull();
  });

  it("renders all commands when no filter applied", () => {
    renderPopup(FIXTURE, "");
    expect(screen.getByText("/status")).toBeTruthy();
    expect(screen.getByText("/stop")).toBeTruthy();
    expect(screen.getByText("/skill:review")).toBeTruthy();
  });

  it("renders null when command list is empty", () => {
    const { container } = renderPopup([], "xyz");
    expect(container.firstChild).toBeNull();
  });
});

describe("CommandPopup — selection", () => {
  it("fires onSelect with the command name on mousedown", () => {
    const onSelect = vi.fn();
    const filtered = FIXTURE.filter((c) => c.name.startsWith("sta"));
    renderPopup(filtered, "sta", 0, onSelect);

    const row = screen.getByRole("option", { name: /status/i });
    fireEvent.mouseDown(row);
    expect(onSelect).toHaveBeenCalledWith("status");
  });

  it("marks selectedIndex row as aria-selected", () => {
    renderPopup(FIXTURE, "", 1);
    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("false");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
  });

  it("fires onHover with the row's flat index on pointer move", () => {
    const onHover = vi.fn();
    renderPopup(FIXTURE, "", 0, vi.fn(), onHover);
    const options = screen.getAllByRole("option");
    fireEvent.mouseMove(options[1]);
    expect(onHover).toHaveBeenCalledWith(1);
    // Moving over the already-selected row does not re-fire.
    onHover.mockClear();
    fireEvent.mouseMove(options[0]);
    expect(onHover).not.toHaveBeenCalled();
  });
});

describe("CommandPopup — grouping", () => {
  it("renders a group header for builtin commands", () => {
    renderPopup(FIXTURE, "");
    expect(screen.getByText("Built-in")).toBeTruthy();
  });

  it("renders a group header for skill commands", () => {
    renderPopup(FIXTURE, "");
    expect(screen.getByText("Skill")).toBeTruthy();
  });

  it("does not render a group header for absent sources", () => {
    renderPopup(FIXTURE, "");
    expect(screen.queryByText("Template")).toBeNull();
    expect(screen.queryByText("Plugin")).toBeNull();
  });
});

describe("CommandPopup — argHint", () => {
  it("renders argHint when present", () => {
    const cmds: CommandInfo[] = [
      { name: "model", description: "Switch model", source: "builtin", argHint: "<model-id>" },
    ];
    renderPopup(cmds, "m");
    expect(screen.getByText("<model-id>")).toBeTruthy();
  });
});
