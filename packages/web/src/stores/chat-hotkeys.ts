import { create } from "zustand";

/**
 * Handlers the chat surfaces register so a single global keydown listener
 * (see `useChatKeybindings`) can reach New thread / Archive / Search /
 * Copy last without threading callbacks through AppShell.
 *
 * Each surface `register`s on mount and returns an unregister that clears
 * only the keys it owned — so unmounting ThreadTree does not wipe a
 * SessionView copy handler that registered later.
 */
export type ChatHotkeyHandler = () => void | Promise<void>;

export interface ChatHotkeyHandlers {
  newThread: ChatHotkeyHandler | null;
  archiveActiveThread: ChatHotkeyHandler | null;
  focusThreadSearch: ChatHotkeyHandler | null;
  copyLastResponse: ChatHotkeyHandler | null;
}

interface ChatHotkeysState extends ChatHotkeyHandlers {
  register: (partial: Partial<ChatHotkeyHandlers>) => () => void;
}

const EMPTY: ChatHotkeyHandlers = {
  newThread: null,
  archiveActiveThread: null,
  focusThreadSearch: null,
  copyLastResponse: null,
};

export const useChatHotkeysStore = create<ChatHotkeysState>((set, get) => ({
  ...EMPTY,
  register: (partial) => {
    set((s) => ({ ...s, ...partial }));
    const owned = Object.keys(partial) as (keyof ChatHotkeyHandlers)[];
    return () => {
      const clear: Partial<ChatHotkeyHandlers> = {};
      const current = get();
      for (const key of owned) {
        // Only clear if we still own the slot — a remount may have replaced us.
        if (current[key] === partial[key]) clear[key] = null;
      }
      if (Object.keys(clear).length > 0) set((s) => ({ ...s, ...clear }));
    };
  },
}));
