// @vitest-environment jsdom
/**
 * Palette (Task 9): every addable node type gets a button, and clicking
 * one fires `onAdd` with that type. Trigger is never in the palette — a
 * workflow has exactly one trigger, created with the definition.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Palette } from "./palette";
import { ADDABLE_NODE_TYPES, NODE_META } from "../editor-model";

describe("Palette", () => {
  it("renders one button per addable node type", () => {
    render(<Palette onAdd={() => {}} />);
    for (const type of ADDABLE_NODE_TYPES) {
      expect(screen.getByRole("button", { name: NODE_META[type].label })).toBeTruthy();
    }
  });

  it("never renders a button for the trigger type", () => {
    render(<Palette onAdd={() => {}} />);
    expect(screen.queryByRole("button", { name: NODE_META.trigger.label })).toBeNull();
  });

  it("fires onAdd with the clicked type", async () => {
    const onAdd = vi.fn();
    const user = userEvent.setup();
    render(<Palette onAdd={onAdd} />);
    await user.click(screen.getByRole("button", { name: NODE_META.if.label }));
    expect(onAdd).toHaveBeenCalledWith("if");
  });
});
