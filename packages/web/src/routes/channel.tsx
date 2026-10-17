import { createFileRoute } from "@tanstack/react-router";
import { textParam } from "~/lib/search-params";
import { redirectToPresence } from "./-presence-redirects";

/**
 * `/channel?key=slack:C123`: redirect-only. One channel is a place page now,
 * `/presence/places/$subject` (`-presence-redirects.ts`).
 */
export const Route = createFileRoute("/channel")({
  beforeLoad: redirectToPresence("/channel"),
  validateSearch: (raw: unknown): { key: string } => ({ key: textParam(raw, "key") ?? "" }),
});
