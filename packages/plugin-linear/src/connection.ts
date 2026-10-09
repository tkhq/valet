/**
 * The organization's Linear connection. It follows the Slack model: paste,
 * verify, store.
 *
 *   1. The admin creates a Linear OAuth app from a prefilled form. The form
 *      turns on the `client_credentials` grant and points the app's own
 *      webhook at `/webhooks/events/linear`.
 *   2. `PUT /connection` takes the app's client ID, client secret, and
 *      webhook signing secret. The handler mints an app-actor token with
 *      `client_credentials` and reads the Linear workspace with it BEFORE the
 *      host stores anything, the way the Slack save runs `auth.test`.
 *
 * There is no browser approval. Linear installs a private app in its own
 * workspace when it issues the `client_credentials` token, and an approval
 * screen for an installed app has no way back to Valet. The host renews the
 * token. No `admin` scope is requested and no webhook is created through the
 * API: the app's webhook belongs to Linear. `DELETE /connection` still
 * removes webhooks that older connections created through `webhookCreate`,
 * best effort.
 *
 * The host authenticates the caller, requires organization administration,
 * and limits the body before it binds the capability below. The capability
 * carries no caller IDs: the host fixes the organization and user.
 */
import type { PluginHttpRequest, PluginHttpRoute } from "@valet/engine";
import {
  createLinearService,
  deleteLinearWebhook,
  LinearTokenError,
  LINEAR_WEBHOOK_RESOURCE_TYPES,
} from "./service.js";

/** Event ingress readiness for the caller's organization. */
export interface LinearConnectionStatus {
  /** The organization saved a Linear app. */
  configured: boolean;
  clientId?: string;
  /** A verified token and installation exist for one Linear workspace. */
  connected: boolean;
  /** The webhook signing secret is saved. */
  webhookConfigured: boolean;
  ready: boolean;
  workspaceName?: string;
  /** The corrective action when the connection is not ready. */
  reason?: string;
}

/** A verified connection. The host stores it for the caller's organization. */
export interface LinearConnectionSave {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  accessToken: string;
  expiresAt: number;
  workspaceId: string;
  workspaceName: string;
}

/** Host persistence bound to one authenticated organization administrator. */
export interface LinearConnectionCapability {
  status(): Promise<LinearConnectionStatus>;
  /** Returns the connected workspace name when a different workspace holds the organization. */
  save(input: LinearConnectionSave): Promise<{ conflictWorkspaceName: string } | null>;
  /** Webhooks that older connections created, with the token that can delete them. */
  legacyWebhooks(): Promise<{ accessToken: string; webhookIds: string[] } | null>;
  /** Removes the app, installation, and token for the organization. */
  disconnect(): Promise<void>;
}

export interface LinearConnectionEndpoints {
  /** The configured public URL of the API. Absent in local development. */
  publicUrl?: string;
  /** The Linear API origin. The host resolves it, so a fixture override
   * reaches every provider call that carries the pasted client secret. */
  linearApiUrl: string;
}

export type LinearConnectionRouteId = "connection-status" | "connection-save" | "connection-delete";

export type LinearConnectionHandlers = Readonly<Record<LinearConnectionRouteId, (request: PluginHttpRequest) => Promise<Response>>>;

const unbound = () => Response.json(
  { error: "This Valet API cannot store Linear connections. Update the API, then connect Linear again." },
  { status: 501 },
);

/** Route declarations. The host binds each ID to `createLinearConnectionHandlers`
 * with a capability for the authenticated caller. These handlers run only on a
 * host that has no Linear connection binding. */
export const linearConnectionRoutes: PluginHttpRoute[] = [
  { id: "connection-status", method: "GET", path: "/connection", auth: "org-admin", maxBodyBytes: 0, handle: unbound },
  { id: "connection-save", method: "PUT", path: "/connection", auth: "org-admin", maxBodyBytes: 1024 * 1024, handle: unbound },
  { id: "connection-delete", method: "DELETE", path: "/connection", auth: "org-admin", maxBodyBytes: 0, handle: unbound },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSecretField(body: Record<string, unknown>, field: string, max: number): string | null {
  const value = body[field];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** Names the fix for a refused `client_credentials` request and quotes
 * Linear's own reason, so a mismatch is visible instead of guessed. */
function tokenRefusalMessage(err: LinearTokenError): string {
  const fix = /does not support the client_credentials grant/i.test(err.detail ?? "")
    ? "In Linear, open the app's settings, turn on Client credentials, and save. Then connect again."
    : "Copy the client ID and client secret again from the app in Linear. Then connect again.";
  return err.detail ? `${fix} Linear said: ${err.detail}` : fix;
}

/** Linear only accepts a public `https://` webhook URL on an app, so there is
 * no URL to prefill without a configured public URL. */
function webhookUrl(publicUrl: string | undefined): string | undefined {
  if (!publicUrl) return undefined;
  try {
    if (new URL(publicUrl).protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return `${publicUrl.replace(/\/+$/, "")}/webhooks/events/linear`;
}

/** Builds the connection handlers for one caller's scoped capability. */
export function createLinearConnectionHandlers(
  capability: LinearConnectionCapability, endpoints: LinearConnectionEndpoints,
): LinearConnectionHandlers {
  async function statusResponse(request: PluginHttpRequest): Promise<Response> {
    // The configured public URL when there is one, else the request's own
    // origin (local development and tests reach the API directly).
    const base = endpoints.publicUrl ?? new URL(request.url).origin;
    const hook = webhookUrl(endpoints.publicUrl);
    return Response.json({
      ...await capability.status(),
      // Linear requires every app to list a redirect URI, because the
      // authorization-code grant is mandatory on all apps. The prefilled form
      // registers this one. Valet never sends a browser to it.
      redirectUri: `${base}/api/org/linear/callback`,
      ...(hook ? { webhookUrl: hook } : {}),
      webhookResourceTypes: [...LINEAR_WEBHOOK_RESOURCE_TYPES],
    });
  }

  return {
    "connection-status": statusResponse,

    async "connection-save"(request) {
      const body = parseJson(request.rawBody);
      const clientId = isRecord(body) ? readSecretField(body, "clientId", 512) : null;
      const clientSecret = isRecord(body) ? readSecretField(body, "clientSecret", 4096) : null;
      const webhookSecret = isRecord(body) ? readSecretField(body, "webhookSecret", 4096) : null;
      if (!clientId || !clientSecret || !webhookSecret) {
        return Response.json({ error: "Enter the Linear app's client ID, client secret, and webhook signing secret." }, { status: 400 });
      }

      // Verify with Linear before storing anything: mint the app-actor token,
      // then read the workspace with it.
      const service = createLinearService({ clientId, clientSecret }, { LINEAR_API_URL: endpoints.linearApiUrl });
      let token: { accessToken: string; expiresAt: number };
      try {
        token = await service.clientCredentialsToken();
      } catch (err) {
        if (err instanceof LinearTokenError && err.status >= 400 && err.status < 500) {
          console.warn("linear connect: Linear refused the client credentials grant:", err.message);
          return Response.json({ error: tokenRefusalMessage(err) }, { status: 400 });
        }
        console.error("linear connect: client credentials request failed:", err);
        return Response.json({ error: "Could not reach Linear to check the app. Try again." }, { status: 502 });
      }
      let workspace: { workspaceId: string; workspaceName: string };
      try {
        workspace = await service.fetchWorkspace(token.accessToken);
      } catch (err) {
        console.error("linear connect: workspace lookup failed:", err);
        return Response.json({ error: "Linear issued a token but the workspace lookup failed. Try again." }, { status: 502 });
      }

      const conflict = await capability.save({
        clientId, clientSecret, webhookSecret,
        accessToken: token.accessToken, expiresAt: token.expiresAt,
        workspaceId: workspace.workspaceId, workspaceName: workspace.workspaceName,
      });
      if (conflict) {
        return Response.json(
          { error: `Another Linear workspace (${conflict.conflictWorkspaceName}) is connected. Disconnect it first.` },
          { status: 409 },
        );
      }
      return statusResponse(request);
    },

    async "connection-delete"() {
      // Connections made before the app-webhook model created their webhook
      // through `webhookCreate`. Remove those best effort: a failure must not
      // block disconnecting, and an orphaned webhook only reaches an ingress
      // that no longer resolves the workspace.
      const legacy = await capability.legacyWebhooks();
      if (legacy) {
        for (const webhookId of legacy.webhookIds) {
          try {
            await deleteLinearWebhook(legacy.accessToken, webhookId, { LINEAR_API_URL: endpoints.linearApiUrl });
          } catch (err) {
            console.error(`linear disconnect: remove webhook ${webhookId} in Linear's settings; delete failed:`, err);
          }
        }
      }
      await capability.disconnect();
      return new Response(null, { status: 204 });
    },
  };
}
