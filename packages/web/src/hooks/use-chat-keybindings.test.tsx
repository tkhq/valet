// @vitest-environment jsdom
/**
 * The global chat keybinding listener, driven by real keydown events rather
 * than by calling the matcher directly. The matcher has its own unit test;
 * what this file pins is the wiring around it, which is where the defects
 * were: a chord that fired while the reader was typing, a chord that fired
 * behind an open modal, and auto-repeat firing a mutation per repeat tick.
 *
 * jsdom reports no Apple platform, so every chord here uses Ctrl.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useChatHotkeysStore } from "~/stores/chat-hotkeys";

let pathname = "/chat";
const toggleCollapsed = vi.fn();
const openDrawer = vi.fn();
let collapsed = false;
let sidebarPresent = true;

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname } }),
}));

vi.mock("~/components/layout/app-shell", () => ({
  useSidebarControls: () => ({
    present: sidebarPresent,
    collapsed,
    toggleCollapsed,
    openDrawer,
  }),
}));

import { useChatKeybindings } from "./use-chat-keybindings";

function Host() {
  useChatKeybindings();
  return null;
}

/** Dispatches a chord from `target` so it bubbles to the window listener. */
function press(code: string, opts: { shift?: boolean; repeat?: boolean; target?: HTMLElement } = {}) {
  const event = new KeyboardEvent("keydown", {
    code,
    key: code,
    ctrlKey: true,
    shiftKey: opts.shift ?? false,
    repeat: opts.repeat ?? false,
    bubbles: true,
    cancelable: true,
  });
  (opts.target ?? window).dispatchEvent(event);
  return event;
}

/** A jsdom `matchMedia` stand-in. jsdom ships none, and the sidebar chord
 * asks for the mobile breakpoint. Built in full rather than cast, so a
 * change to the DOM type shows up here. */
function mediaQueryList(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  };
}

const newThread = vi.fn();
const archiveActiveThread = vi.fn();
const focusThreadSearch = vi.fn();
let unregister: (() => void) | undefined;

beforeEach(() => {
  pathname = "/chat";
  collapsed = false;
  sidebarPresent = true;
  toggleCollapsed.mockClear();
  openDrawer.mockClear();
  newThread.mockClear();
  archiveActiveThread.mockClear();
  focusThreadSearch.mockClear();
  window.matchMedia = (query: string) => mediaQueryList(query);
  unregister = useChatHotkeysStore
    .getState()
    .register({ newThread, archiveActiveThread, focusThreadSearch });
});

afterEach(() => {
  unregister?.();
  unregister = undefined;
  cleanup();
});

describe("useChatKeybindings", () => {
  it("runs the registered handler for each chord", () => {
    render(<Host />);

    press("KeyO", { shift: true });
    expect(newThread).toHaveBeenCalledTimes(1);

    press("Backspace", { shift: true });
    expect(archiveActiveThread).toHaveBeenCalledTimes(1);

    press("KeyK");
    expect(focusThreadSearch).toHaveBeenCalledTimes(1);

    press("KeyS", { shift: true });
    expect(toggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("prevents the browser default for a chord it handles", () => {
    render(<Host />);
    const event = press("KeyO", { shift: true });
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores every chord off the chat route", () => {
    pathname = "/workflows";
    render(<Host />);

    press("KeyO", { shift: true });
    press("Backspace", { shift: true });

    expect(newThread).not.toHaveBeenCalled();
    expect(archiveActiveThread).not.toHaveBeenCalled();
  });

  it("refuses to archive while the reader is typing", () => {
    render(<Host />);
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);

    const event = press("Backspace", { shift: true, target: textarea });

    expect(archiveActiveThread).not.toHaveBeenCalled();
    // The keystroke belongs to the text field, so the chord must not eat it.
    expect(event.defaultPrevented).toBe(false);
    textarea.remove();
  });

  it("still navigates while the reader is typing", () => {
    render(<Host />);
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);

    press("KeyK", { target: textarea });

    expect(focusThreadSearch).toHaveBeenCalledTimes(1);
    textarea.remove();
  });

  it("ignores auto-repeat, so holding the chord archives once", () => {
    render(<Host />);

    press("Backspace", { shift: true });
    press("Backspace", { shift: true, repeat: true });
    press("Backspace", { shift: true, repeat: true });

    expect(archiveActiveThread).toHaveBeenCalledTimes(1);
  });

  it("ignores chords while the shortcuts dialog is open", () => {
    render(<Host />);

    press("Slash");
    // The dialog traps focus but not keydown, so without the guard this
    // would archive the thread behind the modal.
    press("Backspace", { shift: true });

    expect(archiveActiveThread).not.toHaveBeenCalled();
  });

  it("expands a collapsed sidebar before focusing its search field", () => {
    collapsed = true;
    render(<Host />);

    press("KeyK");

    expect(toggleCollapsed).toHaveBeenCalledTimes(1);
    expect(focusThreadSearch).toHaveBeenCalledTimes(1);
  });

  it("stops listening once unmounted", () => {
    const view = render(<Host />);
    view.unmount();

    press("KeyO", { shift: true });

    expect(newThread).not.toHaveBeenCalled();
  });
});
