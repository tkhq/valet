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
