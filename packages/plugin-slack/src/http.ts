/**
 * Slack HTTP routes: the Events API and interactivity ingress, and the
 * org-admin app setup view.
 *
 * The plugin owns the Slack protocol: the URL verification handshake,
 * signature verification over the exact request bytes, payload parsing,
 * retry headers, acknowledgement codes, and the manifest. The host owns
 * authentication, organization selection, credential storage, and the
 * durable inbox. Each handler receives one narrow capability that the host
 * binds to the request. No capability method accepts an organization or
 * user ID.
 *
 * ── Acknowledgement policy ───────────────────────────────────────────────
 * Slack expects a response inside three seconds and redelivers up to three
 * times when it does not get one. Agent work takes far longer, so the route
 * only saves the verified request and acknowledges. The host processes the
 * saved request after the response. A redelivery is admitted like any other
 * delivery, because Slack redelivers only when an earlier attempt got no
 * 2xx. The host inbox and both downstream consumers deduplicate durably.
 */
import type { PluginHttpRequest, PluginHttpRoute, RawChannelUpdate } from "@valet/engine";
import {
  SLACK_OPTIONAL_BOT_SCOPES,
  SLACK_REQUIRED_BOT_SCOPES,
  buildSlackAppManifest,
  missingScopes,
  type SlackAppManifest,
  type SlackManifestOptions,
} from "./app-manifest.js";
import { verifySlackDelivery } from "./transport/verify.js";

/** Slack updates are small JSON. Files arrive by reference, never inline. */
export const SLACK_EVENTS_MAX_BODY_BYTES = 1024 * 1024;

/** The handshake is answered before the signature check, so it is an
 * unauthenticated reflection. Slack's own challenge is a short random
 * string. A longer one is not Slack. */
const MAX_CHALLENGE_CHARS = 512;

/** Slack's "create an app from a manifest" entry point. */
const SLACK_APP_CREATE_URL = "https://api.slack.com/apps?new_app=1";

/** Same clamp Slack applies to `display_information.name`. */
const MAX_APP_NAME_CHARS = 35;

const RETRY_REASONS = new Set(["http_timeout", "http_error", "connection_failed", "ssl_error", "too_many_redirects", "unknown_error"]);

/** Connection state of the host-selected organization, for ingress. */
export type SlackIngressConnection =
  | { state: "unconfigured" }
  /** Slack is connected, but the host cannot process deliveries yet. */
  | { state: "starting" }
  | { state: "ready"; signingSecret: string };

export interface SlackIngressProblem {
  reason: "slack_retry" | "unknown_org" | "transport_unavailable" | "bad_signature";
  /** Operator guidance. Never include message text or credentials. */
  detail: string;
}

export interface SlackDelivery {
  /** Updates parsed from the verified request bytes. */
  updates: RawChannelUpdate[];
  /** `X-Slack-Retry-Num`, or `unknown` when the header is malformed. */
  retryNum?: string;
  retryReason: string;
}

/** Host operations for one ingress request. */
export interface SlackIngressCapability {
  /** Reads the Slack connection of the organization that the host selects. */
  connection(): Promise<SlackIngressConnection>;
  /** Records a throttled operator diagnostic. Never rejects. */
  report(problem: SlackIngressProblem): Promise<void>;
  /**
   * Saves the verified request in the durable inbox before the
   * acknowledgement. The host stores the request bytes and signature headers
   * itself. Rejects when storage fails, so Slack retries the delivery.
   */
  admit(delivery: SlackDelivery): Promise<void>;
}

/** The caller organization's Slack connection, without secrets. */
export interface SlackSetupConnection {
  teamName?: string;
  teamId?: string;
  /** Scopes recorded at connect time. Absent for credentials saved before scopes were recorded. */
  grantedScopes?: string[];
}

/** Host operations for one authenticated setup request. */
export interface SlackSetupCapability {
  /** Returns `null` when the caller's organization has no Slack connection. */
  connection(): Promise<SlackSetupConnection | null>;
  /** Host-owned URLs and the user scope bundle for the manifest. */
  endpoints(): Omit<SlackManifestOptions, "appName">;
}

export interface SlackAppSetupResponse {
  /** `webhook` when Slack can reach this deployment; `socket_mode` otherwise. */
  ingress: "webhook" | "socket_mode";
  requestUrl: string | null;
  createUrl: string;
  manifest: SlackAppManifest;
  requiredScopes: string[];
  optionalScopes: string[];
  connected: boolean;
  teamName?: string;
  teamId?: string;
  /** Requested scopes the installed app did not grant. */
  missingScopes: string[];
}

/** Returns the challenge of a URL verification handshake, if the body is one. */
function handshakeChallenge(bodyText: string): string | undefined {
  // Interactivity bodies are form-encoded, so they are never handshake JSON.
  if (bodyText.startsWith("payload=")) return undefined;
  try {
    const peek: unknown = JSON.parse(bodyText);
    if (typeof peek === "object" && peek !== null && "type" in peek && peek.type === "url_verification" &&
        "challenge" in peek && typeof peek.challenge === "string") {
      return peek.challenge;
    }
  } catch {
    // Not JSON. Signature verification rejects an unparseable body.
  }
  return undefined;
}

/** POST /events, also served at the host's compatibility URL. */
export async function handleSlackEvents(request: PluginHttpRequest, ingress: SlackIngressCapability): Promise<Response> {
  // The handshake comes before the signature check. Slack sends it to enable
  // the endpoint, possibly before the org credential with the secret exists.
  const challenge = handshakeChallenge(new TextDecoder().decode(request.rawBody));
  if (challenge !== undefined) {
    if (challenge.length > MAX_CHALLENGE_CHARS) return Response.json({ error: "challenge too long" }, { status: 400 });
    return Response.json({ challenge });
  }

  // A redelivery means an earlier attempt got no fast 2xx. Record it without
  // delay to the acknowledgement, because this path exists for a slow route.
  const retryHeader = request.headers["x-slack-retry-num"];
  const retryNum = retryHeader === undefined ? undefined : /^\d{1,6}$/.test(retryHeader) ? retryHeader : "unknown";
  const reasonHeader = request.headers["x-slack-retry-reason"];
  const retryReason = reasonHeader && RETRY_REASONS.has(reasonHeader) ? reasonHeader : "unknown";
  if (retryNum !== undefined) {
    void ingress.report({
      reason: "slack_retry",
      detail: `slack redelivered an update (attempt ${retryNum}, reason ${retryReason}). ` +
        "Check the api response time on this route and the last non-2xx it returned.",
    });
  }

  const connection = await ingress.connection();
  if (connection.state === "unconfigured") {
    // Acknowledge rather than 401: a half-configured org must not put Slack
    // into a retry loop against an endpoint that keeps failing.
    await ingress.report({
      reason: "unknown_org",
      detail: "slack webhook received with no usable org credential. " +
        "Connect Slack in Settings to record the signing secret and the workspace id.",
    });
    return new Response(null, { status: 200 });
  }
  if (connection.state === "starting") {
    // Nothing is admitted yet, so Slack must retry after startup.
    await ingress.report({
      reason: "transport_unavailable",
      detail: "slack webhook received but the slack transport is not running. " +
        "Read the api startup log for the slack transport error.",
    });
    return Response.json({ error: "Slack is starting. Retry this delivery shortly." }, { status: 503, headers: { "Retry-After": "5" } });
  }

  // A crafted signature header must never surface as an unauthenticated 500.
  let updates: RawChannelUpdate[] | null;
  try {
    updates = verifySlackDelivery(request.headers, request.rawBody, connection.signingSecret);
  } catch {
    updates = null;
  }
  if (updates === null) {
    await ingress.report({
      reason: "bad_signature",
      detail: "slack webhook signature verification failed. " +
        "Compare the stored signing secret with Basic Information in your Slack app settings.",
    });
    return Response.json({ error: "signature verification failed" }, { status: 401 });
  }

  await ingress.admit({ updates, retryNum, retryReason });
  return new Response(null, { status: 200 });
}

/** GET /app, also served at the host's compatibility URL. Org admins only. */
export async function handleSlackApp(request: PluginHttpRequest, setup: SlackSetupCapability): Promise<Response> {
  // One deployment can run more than one Valet against the same workspace.
  // The operator names them apart, because two apps called "Valet" look the
  // same in the Slack sidebar.
  const requestedName = new URL(request.url).searchParams.get("name");
  const appName = requestedName && requestedName.trim() !== "" ? requestedName.trim().slice(0, MAX_APP_NAME_CHARS) : undefined;
  const endpoints = setup.endpoints();
  const connection = await setup.connection();
  // An older credential carries no scope list. Report nothing missing rather
  // than claim every scope is absent.
  const granted = connection?.grantedScopes;
  const body: SlackAppSetupResponse = {
    ingress: endpoints.requestUrl ? "webhook" : "socket_mode",
    requestUrl: endpoints.requestUrl,
    createUrl: SLACK_APP_CREATE_URL,
    manifest: buildSlackAppManifest({ appName, ...endpoints }),
    requiredScopes: [...SLACK_REQUIRED_BOT_SCOPES],
    optionalScopes: [...SLACK_OPTIONAL_BOT_SCOPES],
    connected: connection !== null,
    teamName: connection?.teamName,
    teamId: connection?.teamId,
    missingScopes: granted ? missingScopes(granted, [...SLACK_REQUIRED_BOT_SCOPES, ...SLACK_OPTIONAL_BOT_SCOPES]) : [],
  };
  return Response.json(body);
}

/** The manifest routes need a host binding for their capabilities. */
function unbound(): Response {
  return Response.json(
    { error: "This Slack route needs host capabilities. Run the bundled Slack plugin in the Valet API." },
    { status: 501 },
  );
}

/**
 * Route descriptors. The Valet API binds `events` and `app` to the handlers
 * above with request-scoped capabilities. Another host gets a 501.
 */
export const slackHttpRoutes: PluginHttpRoute[] = [
  { id: "events", method: "POST", path: "/events", auth: "public", maxBodyBytes: SLACK_EVENTS_MAX_BODY_BYTES, handle: unbound },
  { id: "app", method: "GET", path: "/app", auth: "org-admin", maxBodyBytes: 0, handle: unbound },
];
