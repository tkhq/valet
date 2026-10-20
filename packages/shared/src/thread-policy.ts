/** Where an assistant-waking rule delivers its replies. */
export type AssistantThreadPolicy =
  | { mode: "new" }
  | { mode: "subject" }
  | { mode: "own" }
  | { mode: "existing"; sessionId: string; threadId: string };

export const DEFAULT_THREAD_POLICY: AssistantThreadPolicy = { mode: "own" };

/** Shape check only. Returns null when valid, else the corrective text. */
export function validateThreadPolicy(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "Thread policy must be an object with a mode.";
  }
  const policy = value as Record<string, unknown>;
  if (
    policy.mode !== "new" &&
    policy.mode !== "subject" &&
    policy.mode !== "own" &&
    policy.mode !== "existing"
  ) {
    return "Thread policy mode must be new, subject, own, or existing.";
  }
  const allowed = policy.mode === "existing" ? ["mode", "sessionId", "threadId"] : ["mode"];
  const unknownKey = Object.keys(policy).find((key) => !allowed.includes(key));
  if (unknownKey !== undefined) {
    return `Thread policy has an unknown field "${unknownKey}". Remove it.`;
  }
  if (policy.mode === "existing" && (typeof policy.sessionId !== "string" || typeof policy.threadId !== "string")) {
    return "An existing thread needs sessionId and threadId.";
  }
  return null;
}

/** `value ?? DEFAULT_THREAD_POLICY`, after validation. */
export function readThreadPolicy(value: unknown): AssistantThreadPolicy {
  if (value === undefined) return DEFAULT_THREAD_POLICY;
  if (validateThreadPolicy(value) !== null) return DEFAULT_THREAD_POLICY;
  // Narrowed by validateThreadPolicy: an object whose mode and (for existing) ids are valid.
  return value as AssistantThreadPolicy;
}
