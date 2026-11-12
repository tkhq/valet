import { vi } from "vitest";

/** A `(pointer: coarse)` media query whose match can change during a test. */
export interface FakeCoarsePointer {
  /** Change the match and notify `change` listeners, as a browser does. */
  setMatches(next: boolean): void;
  /** Number of `change` listeners now attached. */
  listenerCount(): number;
}

/**
 * Replace `window.matchMedia` with a fully typed fake where only
 * `(pointer: coarse)` can match. Call `vi.unstubAllGlobals()` to undo it.
 */
export function stubCoarsePointer(initial: boolean): FakeCoarsePointer {
  let matches = initial;
  const listeners = new Set<EventListener>();

  function createList(query: string): MediaQueryList {
    return {
      get matches() { return query === "(pointer: coarse)" && matches; },
      media: query,
      onchange: null,
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (type === "change" && typeof listener === "function") listeners.add(listener);
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (type === "change" && typeof listener === "function") listeners.delete(listener);
      },
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
  }

  vi.stubGlobal("matchMedia", (query: string) => createList(query));

  return {
    setMatches(next) {
      matches = next;
      for (const listener of [...listeners]) listener(new Event("change"));
    },
    listenerCount: () => listeners.size,
  };
}
