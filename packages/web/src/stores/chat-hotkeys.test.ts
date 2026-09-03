import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatHotkeyHandler, useChatHotkeysStore } from "./chat-hotkeys";

beforeEach(() => {
  useChatHotkeysStore.setState({ registrations: [] });
});

describe("chat hotkey registrations", () => {
  it("resolves the handler the only registration provides", () => {
    const newThread = vi.fn();
    useChatHotkeysStore.getState().register({ newThread });

    chatHotkeyHandler("newThread")?.();

    expect(newThread).toHaveBeenCalledTimes(1);
    expect(chatHotkeyHandler("archiveActiveThread")).toBeNull();
  });

  it("prefers the newest registration", () => {
    const first = vi.fn();
    const second = vi.fn();
    useChatHotkeysStore.getState().register({ newThread: first });
    useChatHotkeysStore.getState().register({ newThread: second });

    chatHotkeyHandler("newThread")?.();

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("restores the earlier registration when the newer one unmounts", () => {
    // The layout mounts the sidebar twice below the mobile breakpoint, once
    // as the desktop aside and once inside the drawer. Closing the drawer
    // used to clear a handler the still-mounted aside owned, which left the
    // chord dead for the rest of the session.
    const aside = vi.fn();
    const drawer = vi.fn();
    useChatHotkeysStore.getState().register({ newThread: aside });
    const closeDrawer = useChatHotkeysStore.getState().register({ newThread: drawer });

    closeDrawer();
    chatHotkeyHandler("newThread")?.();

    expect(aside).toHaveBeenCalledTimes(1);
    expect(drawer).not.toHaveBeenCalled();
  });

  it("unregisters out of order without disturbing the survivor", () => {
    const first = vi.fn();
    const second = vi.fn();
    const dropFirst = useChatHotkeysStore.getState().register({ newThread: first });
    useChatHotkeysStore.getState().register({ newThread: second });

    dropFirst();
    chatHotkeyHandler("newThread")?.();

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("falls through to an older registration that provides a different action", () => {
    const archive = vi.fn();
    const newThread = vi.fn();
    useChatHotkeysStore.getState().register({ archiveActiveThread: archive });
    useChatHotkeysStore.getState().register({ newThread });

    chatHotkeyHandler("archiveActiveThread")?.();

    expect(archive).toHaveBeenCalledTimes(1);
  });

  it("reports no handler once every registration is gone", () => {
    const off = useChatHotkeysStore.getState().register({ newThread: vi.fn() });
    off();
    expect(chatHotkeyHandler("newThread")).toBeNull();
  });
});
