import { ApiError } from "~/api/client";

/** The server's error text for a failed action, else the error message, else `fallback`. */
export function extractActionError(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.payload && typeof err.payload === "object") {
    const message = (err.payload as Record<string, unknown>).error;
    if (typeof message === "string" && message) return message;
  }
  return err instanceof Error ? err.message : fallback;
}
