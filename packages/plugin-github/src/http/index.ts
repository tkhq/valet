import { MAX_PLUGIN_HTTP_BODY_BYTES, type PluginHttpRoute } from "@valet/engine";

export type * from "./capabilities.js";
export {
  appCredential,
  appDisconnect,
  appManifest,
  appRefresh,
  appSetup,
  appStatus,
  GITHUB_APP_SETUP_PATH,
  GITHUB_APP_WEBHOOK_PATH,
  GITHUB_CONNECT_CALLBACK_PATH,
  parseManifestConversion,
  parsePrivateKeyPem,
  type GithubAppManifest,
} from "./app.js";
export { connectCallback, connectDisconnect, connectOrgStatus, connectStart, parseAccessTokenResponse } from "./connection.js";
export { parseContentPushPayload, pullRequestWebhookState, receiveWebhook, verifyWebhookSignature } from "./webhook.js";

/** JSON form bodies: a pasted PEM is a few KiB. */
const FORM_BODY_BYTES = 64 * 1024;

/** The manifest routes need a host binding for their capabilities. */
function unbound(): Response {
  return Response.json(
    { error: "This GitHub route needs host capabilities. Run the bundled GitHub plugin in the Valet API." },
    { status: 501 },
  );
}

/**
 * Route descriptors. The Valet API binds each route to the handler of the
 * same name in this module, with request-scoped capabilities. Another host
 * gets a 501.
 */
export const githubHttpRoutes: PluginHttpRoute[] = [
  { id: "app-status", method: "GET", path: "/app", auth: "org-admin", maxBodyBytes: 0, handle: unbound },
  { id: "app-manifest", method: "POST", path: "/app/manifest", auth: "org-admin", maxBodyBytes: FORM_BODY_BYTES, handle: unbound },
  // GitHub's browser redirect. The signed state, not the caller, names the organization.
  { id: "app-setup", method: "GET", path: "/app/setup", auth: "user", maxBodyBytes: 0, handle: unbound },
  { id: "app-credential", method: "POST", path: "/app/credential", auth: "org-admin", maxBodyBytes: FORM_BODY_BYTES, handle: unbound },
  { id: "app-refresh", method: "POST", path: "/app/refresh", auth: "org-admin", maxBodyBytes: FORM_BODY_BYTES, handle: unbound },
  { id: "app-disconnect", method: "DELETE", path: "/app", auth: "org-admin", maxBodyBytes: 0, handle: unbound },
  { id: "connect", method: "POST", path: "/connection/connect", auth: "user", maxBodyBytes: FORM_BODY_BYTES, handle: unbound },
  { id: "org-status", method: "GET", path: "/connection/org-status", auth: "user", maxBodyBytes: 0, handle: unbound },
  { id: "callback", method: "GET", path: "/connection/callback", auth: "user", maxBodyBytes: 0, handle: unbound },
  { id: "disconnect", method: "DELETE", path: "/connection", auth: "user", maxBodyBytes: 0, handle: unbound },
  // Public: the caller is GitHub. The App HMAC is the boundary, and the host
  // binds organization effects only after the handler verifies it.
  { id: "webhook", method: "POST", path: "/webhook", auth: "public", maxBodyBytes: MAX_PLUGIN_HTTP_BODY_BYTES, handle: unbound },
];
