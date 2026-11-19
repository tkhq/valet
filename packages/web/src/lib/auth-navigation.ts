import { authClient } from "~/lib/auth-client";
import { useComposerDraftStore } from "~/stores/composer-drafts";

/** Reload after account changes so no cached identity or pending query crosses users. */
export const AUTH_CHANGE_KEY = "valet:auth-change";

export function finishAuthChange(next: string): void {
  try {
    localStorage.setItem(AUTH_CHANGE_KEY, crypto.randomUUID());
  } catch { /* Navigation still clears this tab when storage is unavailable. */ }
  window.location.assign(next);
}

/**
 * Signs out, then opens `/login`. With `returnTo`, sign-in comes back to
 * that path through `/login?next=` (a same-origin path, checked there).
 */
export async function signOutAndReturn(returnTo?: string): Promise<void> {
  await authClient.signOut();
  useComposerDraftStore.getState().activateOwner("");
  finishAuthChange(returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : "/login");
}
