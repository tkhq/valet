/**
 * Pure helpers for the `/workflows` create/edit form (plan decision 19 —
 * "JSON textarea create/edit form, no visual editor"). Kept separate from
 * the route component so JSON-parsing and error-extraction are unit
 * testable without rendering.
 */
import { ApiError } from "~/api/client";

/** Parses the textarea contents; returns a human error string on failure. */
export function parseDefinitionInput(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "invalid JSON" };
  }
}

/**
 * `POST /workflows` / `PUT /workflows/:id` 400 on an invalid definition with
 * `{ error, errors: string[] }` (`packages/api/src/routes/workflows.ts`
 * `validateDefinitionInput`). Extracts the per-field messages for display;
 * falls back to the mutation's own message for any other failure shape.
 */
export function extractValidationErrors(error: unknown): string[] {
  if (error instanceof ApiError) {
    const payload = error.payload;
    if (typeof payload === "object" && payload !== null && Array.isArray((payload as Record<string, unknown>).errors)) {
      const errs = (payload as Record<string, unknown>).errors;
      if (Array.isArray(errs)) {
        return errs.filter((e): e is string => typeof e === "string");
      }
    }
    return [error.message];
  }
  if (error instanceof Error) return [error.message];
  return ["Something went wrong."];
}
