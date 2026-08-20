import { useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useSidebarControls } from "~/components/layout/app-shell";
import { findMatchedBinding } from "~/lib/chat-keybindings";
import { useComposerPrefillStore } from "~/stores/composer-prefill";
import { useChatHotkeysStore } from "~/stores/chat-hotkeys";

/**
 * Global chat keybindings (claude.ai-shaped). Active on `/chat` only —
 * elsewhere the sidebar and thread handlers are unmounted, so the chords
 * would no-op or fight other pages.
 *
 * Returns help-dialog open state so the host can render
 * `KeyboardShortcutsDialog` beside the listener.
 */
export function useChatKeybindings(): {
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
} {
  const [helpOpen, setHelpOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onChat = pathname === "/chat";
  const sidebar = useSidebarControls();

  useEffect(() => {
    if (!onChat) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;
      const binding = findMatchedBinding(e);
      if (!binding) return;

      e.preventDefault();
      e.stopPropagation();

      const handlers = useChatHotkeysStore.getState();
      switch (binding.id) {
        case "newThread":
          void handlers.newThread?.();
          break;
        case "toggleSidebar":
          if (sidebar?.present) {
            // Mobile has no collapse — open the drawer instead so the chord
            // still reaches the thread list.
            const isMobile = window.matchMedia("(max-width: 767px)").matches;
            if (isMobile) sidebar.openDrawer();
            else sidebar.toggleCollapsed();
          }
          break;
        case "focusComposer":
          useComposerPrefillStore.getState().requestFocus();
          break;
        case "copyLastResponse":
          void handlers.copyLastResponse?.();
          break;
        case "archiveThread":
          void handlers.archiveActiveThread?.();
          break;
        case "searchThreads":
          handlers.focusThreadSearch?.();
          break;
        case "showShortcuts":
          setHelpOpen(true);
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onChat, sidebar]);

  return { helpOpen, setHelpOpen };
}
