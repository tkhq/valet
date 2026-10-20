import { useSyncExternalStore } from "react";

/** The configured public origin that generated file links use
 * (`GET /api/auth-config`). The app entry loads it at boot. It stays null
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

/** Waits between attempts to read the public origin after a failed read. */
export const PUBLIC_ORIGIN_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000];

/**
 * Reads the public origin and retries a failed read. Until a read succeeds,
 * generated download links keep the public hostname, which returns 401 to a
 * person signed in on another one. After the last retry, links keep their href.
 */
export async function loadPublicOrigin(
  read: () => Promise<{ publicOrigin?: string }>,
  delays: readonly number[] = PUBLIC_ORIGIN_RETRY_DELAYS_MS,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      setPublicOrigin((await read()).publicOrigin ?? null);
      return;
    } catch {
      if (attempt >= delays.length) return;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}
