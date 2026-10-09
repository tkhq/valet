/** Optional identity used when an automation replies to a channel. */
export interface Presence {
  displayName?: string;
  avatarUrl?: string;
}

export const PRESENCE_DISPLAY_NAME_MAX_LENGTH = 80;
export const PRESENCE_AVATAR_URL_MAX_LENGTH = 2048;

/** Validate stored configuration without changing the caller's object. */
export function validatePresence(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "Presence must be an object. Set a display name or avatar URL, or remove presence.";
  }
  const presence = value as Record<string, unknown>;
  if (Object.keys(presence).some((key) => key !== "displayName" && key !== "avatarUrl")) {
    return "Presence contains an unknown field. Use displayName and avatarUrl only.";
  }
  if (presence.displayName !== undefined &&
      (typeof presence.displayName !== "string" || presence.displayName.trim().length === 0 ||
       presence.displayName.length > PRESENCE_DISPLAY_NAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(presence.displayName))) {
    return "Presence displayName is invalid. Enter 1 to 80 characters without control characters.";
  }
  if (presence.avatarUrl !== undefined) {
    if (typeof presence.avatarUrl !== "string" || presence.avatarUrl.length > PRESENCE_AVATAR_URL_MAX_LENGTH) {
      return "Presence avatarUrl is invalid. Enter an HTTPS URL of at most 2048 characters.";
    }
    try {
      const url = new URL(presence.avatarUrl);
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password || presence.avatarUrl.trim() !== presence.avatarUrl) {
        return "Presence avatarUrl is invalid. Enter an HTTPS URL without credentials or surrounding spaces.";
      }
    } catch {
      return "Presence avatarUrl is invalid. Enter a complete HTTPS URL.";
    }
  }
  return null;
}

/** Read optional identity from persisted JSON. Ignore invalid legacy values. */
export function readPresence(value: unknown): Presence | undefined {
  if (value === undefined || validatePresence(value) !== null) return undefined;
  const presence = value as Presence;
  return presence.displayName === undefined && presence.avatarUrl === undefined ? undefined : presence;
}

/** Later values override individual fields; absent fields keep their defaults. */
export function mergePresence(...values: (Presence | undefined)[]): Presence | undefined {
  const merged = Object.assign({}, ...values) as Presence;
  return merged.displayName === undefined && merged.avatarUrl === undefined ? undefined : merged;
}
