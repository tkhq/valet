/**
 * Linear API service (event-system plan, Task 9) — the token calls and the
 * GraphQL calls the connect flow needs. Kept out of `routes/linear-connect.ts`
 * so the routes stay thin (validate admin, call service, write rows).
 *
 * The organization connection follows the Slack model: the admin pastes the
 * app's client ID, client secret, and webhook signing secret, and Valet mints
 * an app-actor token with the `client_credentials` grant. Linear owns the
 * webhook (configured on the app itself), so this module no longer creates
 * one. `deleteWebhook` remains only to clean up webhooks that older
 * connections created through the API.
 *
 * Every call goes to Linear's API host (`LINEAR_API_URL`, default
 * `https://api.linear.app`): the token endpoint and GraphQL. Tests point
 * `LINEAR_API_URL` at `startLinearFixture()`.
 */
import { isRecord } from "../lib/oauth-state.js";

/** API host: the token endpoint and GraphQL. */
export function resolveLinearApiUrl(env: NodeJS.ProcessEnv): string {
  return env.LINEAR_API_URL || "https://api.linear.app";
}

export interface LinearService {
  /** `client_credentials` grant: an app-actor token for the app's own
   * workspace, with no browser redirect. Linear issues it for 30 days and
   * without a refresh token; Valet mints a new one before it expires. */
  clientCredentialsToken(): Promise<{ accessToken: string; expiresAt: number }>;
  fetchWorkspace(accessToken: string): Promise<{ workspaceId: string; workspaceName: string }>;
  deleteWebhook(accessToken: string, webhookId: string): Promise<void>;
}

/** Scopes for every app-actor token. Keep this string constant: Linear
 * revokes all of an app's `client_credentials` tokens when one is requested
 * with a different scope set. `admin` is not requested, because `actor=app`
 * installations cannot hold it. */
export const LINEAR_APP_SCOPES = "read,write";

/** Resource types the app's webhook subscribes to. The settings page prefills
 * them into Linear's app form. Keep in sync with the trigger catalog in
 * `@valet/plugin-linear`. */
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

/** A token-endpoint refusal. `detail` carries Linear's `error_description`
 * or `error` so callers can name the fix. */
export class LinearTokenError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: string) {
    super(message);
    this.name = "LinearTokenError";
  }
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

  async function token(label: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
    const form = new URLSearchParams({ ...fields, client_id: config.clientId, client_secret: config.clientSecret });
    let res: Response;
    try {
      res = await fetch(`${apiUrl}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
    } catch (err) {
      throw new Error(`Linear ${label}: request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      payload = undefined;
    }
    if (!res.ok) {
      const detail = isRecord(payload) && typeof payload.error_description === "string" ? payload.error_description
        : isRecord(payload) && typeof payload.error === "string" ? payload.error : undefined;
      throw new LinearTokenError(`Linear ${label}: returned ${res.status}${detail ? `: ${detail}` : ""}`, res.status, detail);
    }
    if (!isRecord(payload) || typeof payload.access_token !== "string" || !payload.access_token) {
      throw new Error(`Linear ${label}: no access_token in response`);
    }
    return payload;
  }

  return {
    async clientCredentialsToken() {
      const payload = await token("client credentials", { grant_type: "client_credentials", scope: LINEAR_APP_SCOPES });
      // Linear documents 30 days. Fall back to that when expires_in is absent.
      const seconds = typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : 30 * 24 * 60 * 60;
      return { accessToken: String(payload.access_token), expiresAt: Date.now() + seconds * 1000 };
    },

    async fetchWorkspace(accessToken) {
      const data = await graphql(accessToken, "fetchWorkspace", "{ organization { id name } viewer { id } }");
      const organization = data.organization;
      if (!isRecord(organization) || typeof organization.id !== "string" || typeof organization.name !== "string") {
        throw new Error("Linear fetchWorkspace: malformed organization in response");
      }
      return { workspaceId: organization.id, workspaceName: organization.name };
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
