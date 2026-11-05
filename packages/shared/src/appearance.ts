/** Optional identity Valet uses when it replies to a channel. UI copy calls it "Appears as". */
export interface Appearance {
  displayName?: string;
  avatarUrl?: string;
}

export const APPEARANCE_DISPLAY_NAME_MAX_LENGTH = 80;
export const APPEARANCE_AVATAR_URL_MAX_LENGTH = 2048;

/** Validate stored configuration without changing the caller's object. */
export function validateAppearance(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "The appearance must be an object. Set a display name or avatar URL, or remove the appearance.";
  }
  const appearance = value as Record<string, unknown>;
  if (Object.keys(appearance).some((key) => key !== "displayName" && key !== "avatarUrl")) {
    return "The appearance contains an unknown field. Use displayName and avatarUrl only.";
  }
  if (appearance.displayName !== undefined &&
      (typeof appearance.displayName !== "string" || appearance.displayName.trim().length === 0 ||
       appearance.displayName.length > APPEARANCE_DISPLAY_NAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(appearance.displayName))) {
    return "The appearance displayName is invalid. Enter 1 to 80 characters without control characters.";
  }
  if (appearance.avatarUrl !== undefined) {
    if (typeof appearance.avatarUrl !== "string" || appearance.avatarUrl.length > APPEARANCE_AVATAR_URL_MAX_LENGTH) {
      return "The appearance avatarUrl is invalid. Enter an HTTPS URL of at most 2048 characters.";
    }
    try {
      const url = new URL(appearance.avatarUrl);
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password || appearance.avatarUrl.trim() !== appearance.avatarUrl) {
        return "The appearance avatarUrl is invalid. Enter an HTTPS URL without credentials or surrounding spaces.";
      }
    } catch {
      return "The appearance avatarUrl is invalid. Enter a complete HTTPS URL.";
    }
  }
  return null;
}

/** Read optional identity from persisted JSON. Ignore invalid legacy values. */
export function readAppearance(value: unknown): Appearance | undefined {
  if (value === undefined || validateAppearance(value) !== null) return undefined;
  const appearance = value as Appearance;
  return appearance.displayName === undefined && appearance.avatarUrl === undefined ? undefined : appearance;
}

/** Later values override individual fields; absent fields keep their defaults. */
export function mergeAppearance(...values: (Appearance | undefined)[]): Appearance | undefined {
  const merged = Object.assign({}, ...values) as Appearance;
  return merged.displayName === undefined && merged.avatarUrl === undefined ? undefined : merged;
}

/** @deprecated Use `Appearance`. Kept for one release while callers move. */
export type Presence = Appearance;
