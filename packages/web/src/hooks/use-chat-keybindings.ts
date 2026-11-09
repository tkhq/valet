import { useCallback, useEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useSidebarControls } from "~/components/layout/app-shell";
import { findMatchedBinding, isEditableTarget } from "~/lib/chat-keybindings";
import { chatHotkeyHandler } from "~/stores/chat-hotkeys";

/**
 * Global chat keybindings. Active on `/chat` only: elsewhere the thread
 * handlers are unmounted, so the chords would no-op or fight another page.
 * `/chat` carries its thread and assistant as search parameters rather than
 * path segments, so an exact pathname test is the whole route.
 *
 * Returns help-dialog open state so the host can render
 * `KeyboardShortcutsDialog` beside the listener.
 */
export function useChatKeybindings(): {
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
} {
  const [helpOpen, setHelpOpenState] = useState(false);
  // The listener reads the dialog state through a ref, not through its own
  // closure. Two keydowns can arrive before React re-renders, and a closure
  // captured on the previous render would still say the dialog was shut.
  const helpOpenRef = useRef(false);
  const setHelpOpen = useCallback((open: boolean) => {
    helpOpenRef.current = open;
    setHelpOpenState(open);
  }, []);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onChat = pathname === "/chat";
  const sidebar = useSidebarControls();

  useEffect(() => {
    if (!onChat) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;
      // Auto-repeat would fire the archive mutation once per repeat tick for
      // as long as the chord is held.
      if (e.repeat) return;
      // The shortcuts dialog traps focus but not keydown, so without this a
      // chord fires against the thread behind an open modal.
      if (helpOpenRef.current) return;

      const binding = findMatchedBinding(e);
      if (!binding) return;

      // Archiving is the one chord that destroys work in progress. It stays
      // off any text field, so a chord pressed mid-message cannot file the
      // thread being written. The rest are navigation and stay global.
      if (binding.id === "archiveThread" && isEditableTarget(e.target)) return;

      e.preventDefault();

      switch (binding.id) {
        case "newThread":
          void chatHotkeyHandler("newThread")?.();
          break;
        case "toggleSidebar":
          if (sidebar?.present) {
            // Mobile has no collapse, so open the drawer instead and the
            // chord still reaches the thread list.
            const isMobile = window.matchMedia("(max-width: 767px)").matches;
            if (isMobile) sidebar.openDrawer();
            else sidebar.toggleCollapsed();
          }
          break;
        case "archiveThread":
          void chatHotkeyHandler("archiveActiveThread")?.();
          break;
        case "searchThreads":
          // The search field lives in the sidebar. Focusing a field the
          // reader cannot see does nothing they can act on, so show it first.
          if (sidebar?.present) {
            if (window.matchMedia("(max-width: 767px)").matches) sidebar.openDrawer();
            else if (sidebar.collapsed) sidebar.toggleCollapsed();
          }
          chatHotkeyHandler("focusThreadSearch")?.();
          break;
        case "showShortcuts":
          setHelpOpen(true);
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onChat, sidebar, setHelpOpen]);

  return { helpOpen, setHelpOpen };
}
