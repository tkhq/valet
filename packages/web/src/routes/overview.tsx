import { createFileRoute, redirect } from "@tanstack/react-router";

/** The workspace overview page is gone: Home is the landing page. Old links
 * to `/overview` land on Home. */
export function leaveOverview(): never {
  throw redirect({ to: "/", replace: true });
}

export const Route = createFileRoute("/overview")({
  beforeLoad: leaveOverview,
});
