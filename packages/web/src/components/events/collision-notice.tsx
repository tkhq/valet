/**
 * The collision report of a line write (TKAI-294). The server refuses a
 * write that covers an existing enabled line (409 with a `collisions`
 * payload) and commits a partial overlap with the same payload as a
 * warning. The editor's side pane shows either one.
 */
import type { EventSubscriptionCollisionsWire } from "@valet/api/wire";
import { ApiError } from "~/api/client";

/** The collision payload of a blocked (409) subscription write, or null when
 * the failure is not one. */
export function collisionsFromError(err: unknown): EventSubscriptionCollisionsWire | null {
  if (!(err instanceof ApiError)) return null;
  const payload = err.payload;
  if (typeof payload !== "object" || payload === null || !("collisions" in payload)) return null;
  const collisions = (payload as { collisions: unknown }).collisions;
  if (typeof collisions !== "object" || collisions === null) return null;
  const report = collisions as { blocking?: unknown; overlapping?: unknown };
  if (!Array.isArray(report.blocking) || !Array.isArray(report.overlapping)) return null;
  return collisions as EventSubscriptionCollisionsWire;
}
