/**
 * Focus return for Radix menus, popovers and dialogs.
 *
 * On close, Radix moves focus back to the trigger with a script `focus()`.
 * Chromium shows a focus ring on a script focus when the element that had
 * focus before showed one, and Radix moves focus by script at each step, so
 * a ring that showed before the click (a tour button, a text field) carries
 * to the trigger after a mouse close. `quietCloseAutoFocus` keeps focus
 * where Radix puts it and takes the ring off after a pointer close. A
 * keyboard close keeps the ring, so keyboard users still see where focus
 * landed.
 */

let lastInputWasPointer = false;
if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", () => { lastInputWasPointer = true; }, true);
  document.addEventListener("keydown", () => { lastInputWasPointer = false; }, true);
}

// lib.dom does not type `focusVisible` yet. Browsers without it ignore the
// option and keep the old behavior.
const NO_RING: FocusOptions & { focusVisible: boolean } = { focusVisible: false };

/**
 * An `onCloseAutoFocus` handler. It runs after the caller's own handler
 * and does nothing when that handler prevented the default. Radix moves
 * focus during the same event, so the check waits a microtask. A text
 * field keeps its focus untouched: a blur would fire its commit handlers.
 */
export function quietCloseAutoFocus(event: Event, own?: (event: Event) => void): void {
  own?.(event);
  if (event.defaultPrevented || !lastInputWasPointer) return;
  queueMicrotask(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
    if (!el.matches(":focus-visible")) return;
    el.blur();
    el.focus(NO_RING);
  });
}
