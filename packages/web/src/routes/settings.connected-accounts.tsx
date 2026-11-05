import { Navigate, createFileRoute, useSearch } from "@tanstack/react-router";
import { textParam } from "~/lib/search-params";
import { PERSONAL } from "~/lib/workspace-scope";

/**
 * `/settings/connected-accounts` moved to personal Integrations, which holds
 * the chat identity links, GitHub, and your 1Password token. The path stays
 * as a redirect for old links, emails, and OAuth returns. An older GitHub
 * return carries `?github=connected`, which Integrations reads as
 * `?connected=github`.
 */
export const Route = createFileRoute("/settings/connected-accounts")({
  component: ConnectedAccountsRedirect,
});

function ConnectedAccountsRedirect() {
  // The top-level hook, not `Route.useSearch()`: tests mount this component
  // in a route tree of their own. `href` wins over `to` and carries the
  // connect result, which the Integrations search schema leaves out.
  return <Navigate to="/integrations" href={connectedAccountsTarget(useSearch({ strict: false }))} replace />;
}

/** Where an old Connected accounts link lands, with its connect result kept. */
export function connectedAccountsTarget(search: unknown): string {
  const target = new URLSearchParams({ workspace: PERSONAL });
  if (textParam(search, "github") === "connected") target.set("connected", "github");
  for (const key of ["connected", "error", "detail"]) {
    const value = textParam(search, key);
    if (value) target.set(key, value);
  }
  return `/integrations?${target}`;
}
