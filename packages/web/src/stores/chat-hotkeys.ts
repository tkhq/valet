import { create } from "zustand";

/**
 * Handlers the chat surfaces register so one global keydown listener (see
 * `useChatKeybindings`) can reach New thread / Archive / Search without
 * threading callbacks through AppShell.
 *
 * Registrations form a STACK rather than a set of slots. Two surfaces can
 * legitimately provide the same handler at once: below the mobile
 * breakpoint the layout mounts the sidebar twice, once as the desktop aside
 * and once inside the drawer. With one slot per handler the drawer's
 * unmount cleared a slot the still-mounted aside owned, and the chord was
 * dead for the rest of the session. A stack makes the newest registration
 * win and restores the previous one when it unmounts, in any order.
 */
export type ChatHotkeyHandler = () => void | Promise<void>;

export interface ChatHotkeyHandlers {
  newThread: ChatHotkeyHandler | null;
  archiveActiveThread: ChatHotkeyHandler | null;
  focusThreadSearch: ChatHotkeyHandler | null;
}

interface Registration {
  id: number;
  handlers: Partial<ChatHotkeyHandlers>;
}

interface ChatHotkeysState {
  registrations: Registration[];
  register: (handlers: Partial<ChatHotkeyHandlers>) => () => void;
}

let nextRegistrationId = 1;

export const useChatHotkeysStore = create<ChatHotkeysState>((set) => ({
  registrations: [],
  register: (handlers) => {
    const id = nextRegistrationId++;
    set((s) => ({ registrations: [...s.registrations, { id, handlers }] }));
    return () => {
      set((s) => ({ registrations: s.registrations.filter((r) => r.id !== id) }));
    };
  },
}));

/**
 * The handler for one action, from the newest registration that provides
 * it. Null when nothing mounted provides it, which the caller treats as
 * "this chord does nothing right now" rather than an error.
 */
export function chatHotkeyHandler(key: keyof ChatHotkeyHandlers): ChatHotkeyHandler | null {
  const { registrations } = useChatHotkeysStore.getState();
  for (let i = registrations.length - 1; i >= 0; i--) {
    const handler = registrations[i]?.handlers[key];
    if (handler) return handler;
  }
  return null;
}
