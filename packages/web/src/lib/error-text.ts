import { ApiError } from "~/api/client";

/** Server-side messages carry the corrective action; a network failure does
 * not, so it gets one here. */
export function errorText(err: unknown, fallback = "The request failed. Try again."): string {
  if (err instanceof ApiError) {
    const payload = err.payload;
    if (typeof payload === "object" && payload !== null && "error" in payload) {
      const message = (payload as { error: unknown }).error;
      if (typeof message === "string") return message;
    }
    return err.message;
  }
  if (err instanceof Error) return `${err.message}. Check the server is running, then try again.`;
  return fallback;
}

/**
 * The per-field messages of a validation failure, or null when the failure
 * is not one.
 *
 * A definition the validator refuses answers with `errors` beside `error`,
 * and that list is the whole value of the response: it names each node and
 * field the author must correct. "invalid workflow definition" on its own
 * tells them nothing they can act on. Every other failure — a 404, a 500, a
 * dead network — carries no such list, and a caller that wants to say "this
 * is invalid" must be able to tell the two apart.
 */
export function validationMessages(err: unknown): string[] | null {
  if (!(err instanceof ApiError)) return null;
  const payload = err.payload;
  if (typeof payload !== "object" || payload === null || !("errors" in payload)) return null;
  const detail = payload.errors;
  if (!Array.isArray(detail)) return null;
  const messages = detail.filter((entry): entry is string => typeof entry === "string");
  return messages.length === 0 ? null : messages;
}

/** Every message a failure carries, not only the headline. */
export function errorMessages(err: unknown, fallback?: string): string[] {
  return validationMessages(err) ?? [errorText(err, fallback)];
}
