// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { quietCloseAutoFocus } from "./close-focus";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function closeEvent(): Event {
  const event = new CustomEvent("focusScope.autoFocusOnUnmount", { cancelable: true });
  document.body.dispatchEvent(event);
  return event;
}

/** Stands in for Radix, which focuses the trigger during the close event. */
function focusedTrigger(): HTMLButtonElement {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  return trigger;
}

describe("quietCloseAutoFocus", () => {
  it("takes the ring off the focused trigger after a pointer close", async () => {
    const trigger = focusedTrigger();
    const focus = vi.spyOn(trigger, "focus");
    document.dispatchEvent(new Event("pointerdown"));
    quietCloseAutoFocus(closeEvent());
    await Promise.resolve();
    expect(focus).toHaveBeenCalledWith({ focusVisible: false });
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps the ring after a keyboard close", async () => {
    const trigger = focusedTrigger();
    const focus = vi.spyOn(trigger, "focus");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    quietCloseAutoFocus(closeEvent());
    await Promise.resolve();
    expect(focus).not.toHaveBeenCalled();
  });

  it("leaves focus to a caller's own handler that prevents the default", async () => {
    const trigger = focusedTrigger();
    const focus = vi.spyOn(trigger, "focus");
    document.dispatchEvent(new Event("pointerdown"));
    quietCloseAutoFocus(closeEvent(), (event) => event.preventDefault());
    await Promise.resolve();
    expect(focus).not.toHaveBeenCalled();
  });

  it("does not blur a text field", async () => {
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    const blur = vi.spyOn(field, "blur");
    document.dispatchEvent(new Event("pointerdown"));
    quietCloseAutoFocus(closeEvent());
    await Promise.resolve();
    expect(blur).not.toHaveBeenCalled();
  });
});

it("a dropdown menu closed by a click returns focus to its trigger without a ring", async () => {
  render(
    <DropdownMenu>
      <DropdownMenuTrigger asChild><button type="button">Plugins</button></DropdownMenuTrigger>
      <DropdownMenuContent aria-label="Plugins"><DropdownMenuItem>Valet Security</DropdownMenuItem></DropdownMenuContent>
    </DropdownMenu>,
  );
  const trigger = screen.getByRole("button", { name: "Plugins" });
  const focus = vi.spyOn(trigger, "focus");
  const user = userEvent.setup();
  await user.click(trigger);
  await user.click(await screen.findByRole("menuitem", { name: "Valet Security" }));
  await vi.waitFor(() => expect(focus).toHaveBeenCalledWith({ focusVisible: false }));
});
