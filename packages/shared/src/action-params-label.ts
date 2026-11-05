/**
 * One short label for an action's parameters, such as the name of the
 * project a create call makes. The workflow approval card shows it above
 * the raw parameters, and the approval notification puts it in its title,
 * so a person can tell two waiting approvals apart without opening them.
 */

/** Keys that usually name what an action creates or changes, most specific first. */
const LABEL_KEYS = ["name", "title", "subject", "summary"] as const;

const MAX_CHARS = 80;

export interface ActionParamsLabel {
  key: (typeof LABEL_KEYS)[number];
  value: string;
}

/** Returns the first non-empty text field in `LABEL_KEYS`, whitespace
 * collapsed and cut to 80 characters, or undefined when there is none. */
export function actionParamsLabel(params: unknown): ActionParamsLabel | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
  for (const key of LABEL_KEYS) {
    const raw: unknown = (params as Record<string, unknown>)[key];
    if (typeof raw !== "string") continue;
    const value = raw.replace(/\s+/g, " ").trim();
    if (value) return { key, value: value.length > MAX_CHARS ? `${value.slice(0, MAX_CHARS - 1)}…` : value };
  }
  return undefined;
}
