/**
 * A signed-in user's own GitHub connection through the organization's App.
 * A successful callback saves a repository-capable user `github` credential:
 * `{ accessToken, refreshToken?, expiresAt?, login }`.
 *
 * The callback runs behind host authentication, because the browser that
 * started the flow returns with its session. The host also checks that the
 * signed state names the signed-in user. This blocks a replayed state from
 * another user's browser.
 */
import type { PluginHttpRequest } from "@valet/engine";
import type { GithubConnectionCapability, GithubEndpoints, GithubPostAuthDestination } from "./capabilities.js";
import { isRecord, json, noContent, queryParam, readJson, redirect } from "./respond.js";

const NO_APP = "no GitHub App is configured for this organization; ask an admin to set it up first";

/** Only the Integrations reconnect may change the destination. A fixed value
 * keeps OAuth state from carrying an external redirect. */
function postAuthDestination(value: unknown): GithubPostAuthDestination | undefined {
  return value === "integrations" ? value : undefined;
}

export async function connectStart(
  request: PluginHttpRequest,
  connection: GithubConnectionCapability,
  endpoints: GithubEndpoints,
): Promise<Response> {
  const clientId = await connection.oauthClientId();
  if (clientId === null) return json({ error: NO_APP }, 409);

  const body = readJson(request);
  const destination = isRecord(body) ? postAuthDestination(body.postAuthDestination) : undefined;
  const state = connection.signConnectState(destination);
  const url = `${endpoints.githubUrl}/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&state=${encodeURIComponent(state)}`;
  return json({ url });
}

/** The App's state for any member: no App ID, slug, logins, or secrets. */
export async function connectOrgStatus(connection: GithubConnectionCapability): Promise<Response> {
  return json(await connection.orgStatus());
}

interface AccessToken {
  accessToken: string;
  refreshToken?: string;
  expiresInMs?: number;
}

/** GitHub answers `POST /login/oauth/access_token` with HTTP 200 even on
 * error, so a missing `access_token` is a rejection too. */
export function parseAccessTokenResponse(payload: unknown): AccessToken | null {
  if (!isRecord(payload)) return null;
  const accessToken = payload.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;
  const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : undefined;
  const expiresIn = payload.expires_in;
  const expiresInMs = typeof expiresIn === "number" ? expiresIn * 1000 : undefined;
  return { accessToken, refreshToken, expiresInMs };
}

export async function connectCallback(
  request: PluginHttpRequest,
  connection: GithubConnectionCapability,
  endpoints: GithubEndpoints,
): Promise<Response> {
  const code = queryParam(request, "code");
  const state = queryParam(request, "state");
  if (!code || !state) return json({ error: "missing code or state" }, 400);

  const opening = connection.openCallback(state);
  if (opening.status === "invalid") return json({ error: "invalid or expired state" }, 400);
  if (opening.status === "other-user") {
    return json({ error: "this authorization was not started by the signed-in user" }, 400);
  }
  const { grant } = opening;

  const client = await grant.oauthClient();
  if (!client) return json({ error: NO_APP }, 409);

  let tokenRes: Response;
  try {
    tokenRes = await fetch(`${endpoints.githubUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Valet-App",
      },
      body: JSON.stringify({ client_id: client.clientId, client_secret: client.clientSecret, code }),
    });
  } catch (err) {
    console.error("github connect callback: token exchange request failed:", err);
    return json({ error: "failed to reach GitHub" }, 502);
  }
  if (!tokenRes.ok) {
    if (tokenRes.status >= 500) return json({ error: `GitHub returned ${tokenRes.status}` }, 502);
    return json({ error: `GitHub rejected the authorization code (status ${tokenRes.status})` }, 400);
  }

  let tokenPayload: unknown;
  try {
    tokenPayload = await tokenRes.json();
  } catch {
    return json({ error: "malformed response from GitHub" }, 502);
  }
  const token = parseAccessTokenResponse(tokenPayload);
  if (!token) return json({ error: "GitHub did not return an access token" }, 400);

  let userRes: Response;
  try {
    userRes = await fetch(`${endpoints.githubApiUrl}/user`, {
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Valet-App",
      },
    });
  } catch (err) {
    console.error("github connect callback: GET /user request failed:", err);
    return json({ error: "failed to reach GitHub" }, 502);
  }
  if (!userRes.ok) {
    return json({ error: `GitHub returned ${userRes.status} fetching the account profile` }, 502);
  }

  let userPayload: unknown;
  try {
    userPayload = await userRes.json();
  } catch {
    return json({ error: "malformed response from GitHub" }, 502);
  }
  const login = isRecord(userPayload) && typeof userPayload.login === "string" ? userPayload.login : null;
  if (!login) return json({ error: "malformed response from GitHub" }, 502);

  await grant.saveConnection({
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresInMs !== undefined ? Date.now() + token.expiresInMs : undefined,
    login,
  });

  // The Integrations page reads `?connected=<service>`. The Settings
  // connected-accounts page reads `?github=connected`.
  const { destination, query } =
    grant.postAuthDestination === "integrations"
      ? { destination: "/integrations", query: "connected=github" }
      : { destination: "/settings/connected-accounts", query: "github=connected" };
  return redirect(`${grant.returnTo}${destination}?${query}`);
}

export async function connectDisconnect(connection: GithubConnectionCapability): Promise<Response> {
  await connection.disconnect();
  return noContent();
}
