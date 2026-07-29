/**
 * Linear API service (event-system plan, Task 9) — OAuth code exchange and
 * the GraphQL calls the connect flow needs (workspace lookup, webhook
 * create/delete). Kept out of `routes/linear-connect.ts` so the routes stay
 * thin (validate admin, call service, write rows).
 *
 * ── URL scheme ────────────────────────────────────────────────────────────
 * Linear splits its hosts: the BROWSER authorize page lives on the web app
 * (`https://linear.app/oauth/authorize`) while the token endpoint and
 * GraphQL API live on the API host (`https://api.linear.app/oauth/token`,
 * `https://api.linear.app/graphql`). So:
 *
 *   - `LINEAR_OAUTH_URL ?? "https://linear.app"` — ONLY for building the
 *     browser authorize URL (`resolveLinearOauthUrl`, used by the route).
 *   - `LINEAR_API_URL ?? "https://api.linear.app"` — every server-side HTTP
 *     call this module makes: token exchange AND GraphQL.
 *
 * Tests point `LINEAR_API_URL` at `startLinearFixture()` (same pattern as
 * `GITHUB_API_URL` / `startGithubFixture`); `LINEAR_OAUTH_URL` never
 * receives traffic — it only shapes the URL string handed to the browser.
 */
import { isRecord } from "../lib/oauth-state.js";

/** Browser-facing web-app host — authorize URL construction only. */
export function resolveLinearOauthUrl(env: NodeJS.ProcessEnv): string {
  return env.LINEAR_OAUTH_URL || "https://linear.app";
}

/** API host — token exchange + GraphQL. */
export function resolveLinearApiUrl(env: NodeJS.ProcessEnv): string {
  return env.LINEAR_API_URL || "https://api.linear.app";
}

export interface LinearService {
  exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string }>;
  fetchWorkspace(accessToken: string): Promise<{ workspaceId: string; workspaceName: string }>;
  createWebhook(accessToken: string, args: { url: string; secret: string }): Promise<{ webhookId: string }>;
  deleteWebhook(accessToken: string, webhookId: string): Promise<void>;
}

/** Resource types the auto-created workspace webhook subscribes to — keep in
 * sync with the trigger catalog in `@valet/plugin-linear`. */
export const LINEAR_WEBHOOK_RESOURCE_TYPES = [
  "Issue",
  "Comment",
  "Project",
  "Cycle",
  "IssueLabel",
  "Reaction",
] as const;

interface GraphqlResult {
  data?: Record<string, unknown>;
  errors?: unknown[];
}

export interface LinearClientConfig {
  clientId: string;
  clientSecret: string;
}

export function createLinearService(config: LinearClientConfig, env: NodeJS.ProcessEnv = process.env): LinearService {
  const apiUrl = resolveLinearApiUrl(env);

  async function graphql(accessToken: string, label: string, query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(`${apiUrl}/graphql`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw new Error(`Linear ${label}: request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new Error(`Linear ${label}: API returned ${res.status}`);

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new Error(`Linear ${label}: malformed (non-JSON) response`);
    }
    const result = payload as GraphqlResult;
    if (Array.isArray(result.errors) && result.errors.length > 0) {
      throw new Error(`Linear ${label}: GraphQL errors: ${JSON.stringify(result.errors)}`);
    }
    if (!isRecord(result.data)) throw new Error(`Linear ${label}: response has no data`);
    return result.data;
  }

  return {
    async exchangeCode(code, redirectUri) {
      const form = new URLSearchParams({
        code,
        redirect_uri: redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
      });
      let res: Response;
      try {
        res = await fetch(`${apiUrl}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        });
      } catch (err) {
        throw new Error(`Linear token exchange: request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) throw new Error(`Linear token exchange: returned ${res.status}`);

      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        throw new Error("Linear token exchange: malformed (non-JSON) response");
      }
      const accessToken = isRecord(payload) && typeof payload.access_token === "string" ? payload.access_token : null;
      if (!accessToken) throw new Error("Linear token exchange: no access_token in response");
      return { accessToken };
    },

    async fetchWorkspace(accessToken) {
      const data = await graphql(accessToken, "fetchWorkspace", "{ organization { id name } viewer { id } }");
      const organization = data.organization;
      if (!isRecord(organization) || typeof organization.id !== "string" || typeof organization.name !== "string") {
        throw new Error("Linear fetchWorkspace: malformed organization in response");
      }
      return { workspaceId: organization.id, workspaceName: organization.name };
    },

    async createWebhook(accessToken, { url, secret }) {
      const data = await graphql(
        accessToken,
        "webhookCreate",
        "mutation($input: WebhookCreateInput!) { webhookCreate(input: $input) { success webhook { id } } }",
        { input: { url, secret, allPublicTeams: true, resourceTypes: [...LINEAR_WEBHOOK_RESOURCE_TYPES] } },
      );
      const result = data.webhookCreate;
      if (!isRecord(result) || result.success !== true) {
        throw new Error(`Linear webhookCreate: mutation did not succeed: ${JSON.stringify(data)}`);
      }
      const webhook = result.webhook;
      if (!isRecord(webhook) || typeof webhook.id !== "string") {
        throw new Error("Linear webhookCreate: no webhook id in response");
      }
      return { webhookId: webhook.id };
    },

    async deleteWebhook(accessToken, webhookId) {
      const data = await graphql(
        accessToken,
        "webhookDelete",
        "mutation($id: String!) { webhookDelete(id: $id) { success } }",
        { id: webhookId },
      );
      const result = data.webhookDelete;
      if (!isRecord(result) || result.success !== true) {
        throw new Error(`Linear webhookDelete: mutation did not succeed: ${JSON.stringify(data)}`);
      }
    },
  };
}
