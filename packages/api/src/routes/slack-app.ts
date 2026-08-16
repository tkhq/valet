/**
 * `GET /api/org/slack` — the Slack agent app setup surface, org-admin only.
 *
 * Returns the manifest an operator pastes into Slack's app-creation form,
 * the ingress URL that manifest points at, and the connection state of the
 * org's Slack credential. Slack's `apps.manifest.create` method needs an
 * app-configuration token this deployment does not hold, so the operator
 * pastes rather than the API creating the app.
 *
 * ── Authorization ────────────────────────────────────────────────────────
 * `requireOrgAdmin` checks `org_members.role` for the caller's own org in
 * application code, before any read. The org id comes from the
 * authenticated session (`c.var.user.orgId`), never from the request, so
 * there is no cross-org read to defend against here and no resource id to
 * 404 on. Routes that do take a resource id must authorize the same way —
 * fetch, then compare owners in code, and answer 404 on a mismatch — rather
 * than filtering by owner in the query, which reports "missing" and
 * "forbidden" as the same empty result.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import { publicUrlFromEnv } from "../channels/host.js";
import {
  SLACK_OPTIONAL_BOT_SCOPES,
  SLACK_REQUIRED_BOT_SCOPES,
  buildSlackAppManifest,
  missingScopes,
  slackRequestUrl,
} from "../services/slack-app.js";
import type { GetSlackAppResponse } from "../wire/types.js";

export const slackAppRouter = new Hono<AppEnv>();

/** Slack's "create an app from a manifest" entry point. */
const SLACK_APP_CREATE_URL = "https://api.slack.com/apps?new_app=1";

/** Same clamp Slack applies to `display_information.name`. */
const MAX_APP_NAME_CHARS = 35;

slackAppRouter.get("/", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const { engineCredentials } = c.var.providers;
  const orgId = c.var.user.orgId;

  // One deployment can run more than one Valet against the same workspace
  // (a development app beside a production app). The operator names them
  // apart here, because two apps called "Valet" are indistinguishable in
  // the Slack sidebar.
  const requestedName = c.req.query("name");
  const appName = requestedName && requestedName.trim() !== "" ? requestedName.trim().slice(0, MAX_APP_NAME_CHARS) : undefined;

  const publicUrl = publicUrlFromEnv(process.env) ?? null;
  const requestUrl = slackRequestUrl(publicUrl);

  const credential = await engineCredentials.get({ type: "org", id: orgId }, "slack");
  const metadata = credential?.metadata;
  // Scopes are recorded at connect time from Slack's `x-oauth-scopes`
  // response header (see `routes/credentials.ts`), so reporting what is
  // missing costs no extra call to Slack. An older credential saved before
  // that recording existed carries no scope list; report nothing missing
  // rather than claim every scope is absent.
  const granted = credential?.scopes;

  const body: GetSlackAppResponse = {
    ingress: requestUrl ? "webhook" : "socket_mode",
    requestUrl,
    createUrl: SLACK_APP_CREATE_URL,
    manifest: buildSlackAppManifest({ appName, publicUrl }),
    requiredScopes: [...SLACK_REQUIRED_BOT_SCOPES],
    optionalScopes: [...SLACK_OPTIONAL_BOT_SCOPES],
    connected: credential !== null,
    teamName: typeof metadata?.teamName === "string" ? metadata.teamName : undefined,
    teamId: typeof metadata?.teamId === "string" ? metadata.teamId : undefined,
    missingScopes: granted ? missingScopes(granted, [...SLACK_REQUIRED_BOT_SCOPES, ...SLACK_OPTIONAL_BOT_SCOPES]) : [],
  };
  return c.json(body);
});
