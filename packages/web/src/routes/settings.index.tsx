import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/settings` resting state — no content of its own; redirects to the first
 * You section per the spec's route table (`/settings → /settings/profile`).
 * Exported standalone (rather than inlined in `beforeLoad`) so the redirect
 * itself is directly testable without reaching into the route object's
 * generic-heavy type.
 */
export function redirectToProfile(): never {
  throw redirect({ to: "/settings/profile" });
}

export const Route = createFileRoute("/settings/")({
  beforeLoad: redirectToProfile,
});
