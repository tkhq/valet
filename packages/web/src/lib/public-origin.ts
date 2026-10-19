import { useSyncExternalStore } from "react";

/** The configured public origin that generated file links use
 * (`GET /api/auth-config`). The app entry sets it once at boot. It stays null
 * in tests and on fixture pages, so links keep their href there. */
let publicOrigin: string | null = null;
const listeners = new Set<() => void>();

export function setPublicOrigin(origin: string | null): void {
  publicOrigin = origin;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePublicOrigin(): string | null {
  return useSyncExternalStore(subscribe, () => publicOrigin, () => null);
}
