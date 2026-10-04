/** Reload after account changes so no cached identity or pending query crosses users. */
export const AUTH_CHANGE_KEY = "valet:auth-change";

export function finishAuthChange(next: string): void {
  try {
    localStorage.setItem(AUTH_CHANGE_KEY, crypto.randomUUID());
  } catch { /* Navigation still clears this tab when storage is unavailable. */ }
  window.location.assign(next);
}
