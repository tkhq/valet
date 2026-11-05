/**
 * Host bindings and persistence for the Linear plugin's connection routes.
 * The route mount runs a binding, which builds this capability, only after
 * it authenticates the caller, checks organization membership and
 * administration, and limits the body.
 * Every operation uses the host caller's organization and user. Request
 * input cannot choose either identity.
 *
 * Storage stays in the existing `linear_app` and `linear` credential rows
 * and the `linear_installations` table, pending plugin-owned storage
 * (TKAI-378). Token renewal stays in `LinearAppTokenStore`.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { PluginHttpCaller, PluginHttpRoute } from "@valet/engine";
import {
  createLinearConnectionHandlers,
  type LinearConnectionCapability,
  type LinearConnectionEndpoints,
  type LinearConnectionRouteId,
} from "@valet/plugin-linear/connection";
import { resolveLinearApiUrl } from "@valet/plugin-linear/service";
import { publicUrlFromEnv } from "../channels/host.js";
import type { Providers } from "../providers/types.js";
import { orgs, linearInstallations } from "../schema/index.js";
import { replaceCredential } from "../services/credential-insert.js";
import {
  loadLinearAppConfig,
  LINEAR_APP_SERVICE,
  LINEAR_CLIENT_CREDENTIALS_GRANT,
  LINEAR_CREDENTIAL_SERVICE,
} from "../services/linear-app.js";
import { getLinearIngressStatus } from "../services/linear-ingress.js";
import type { PluginHttpBinding } from "./http-bindings.js";

/** The plugin has no environment default: the host always names the Linear origin. */
export function linearConnectionEndpoints(env: NodeJS.ProcessEnv): LinearConnectionEndpoints {
  const publicUrl = publicUrlFromEnv(env);
  return { ...(publicUrl ? { publicUrl } : {}), linearApiUrl: resolveLinearApiUrl(env) };
}

export function createLinearConnectionCapability(
  providers: Pick<Providers, "db" | "engineCredentials" | "encryptionKey">,
  caller: PluginHttpCaller,
): LinearConnectionCapability {
  const { db, engineCredentials, encryptionKey } = providers;
  const owner = { type: "org" as const, id: caller.orgId };

  return {
    status: () => getLinearIngressStatus(db, engineCredentials, caller.orgId),

    save: (input) => db.transaction(async (tx) => {
      // The organization row lock serializes concurrent reconnects.
      await tx.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, caller.orgId)).for("update");
      // One workspace per org: the org credential holds exactly one token.
      const installs = await tx.select().from(linearInstallations).where(eq(linearInstallations.orgId, caller.orgId));
      const foreign = installs.find((install) => install.workspaceId !== input.workspaceId);
      if (foreign) return { conflictWorkspaceName: foreign.workspaceName };
      const existing = installs.find((install) => install.workspaceId === input.workspaceId);

      // One id for this connection on both rows (`LinearAppConfig.connectionId`).
      // A token renewal that started before this save sees a new ID and
      // discards the token it minted.
      const connectionId = randomUUID();
      await replaceCredential(tx, encryptionKey, owner, LINEAR_APP_SERVICE, {
        type: "service_account", apiKey: input.clientSecret, metadata: { clientId: input.clientId, connectionId },
      });
      await replaceCredential(tx, encryptionKey, owner, LINEAR_CREDENTIAL_SERVICE, {
        type: "oauth2",
        accessToken: input.accessToken,
        metadata: {
          webhookSecret: input.webhookSecret,
          workspaceId: input.workspaceId,
          grant: LINEAR_CLIENT_CREDENTIALS_GRANT,
          tokenExpiresAt: input.expiresAt,
          connectionId,
        },
      });
      const now = Date.now();
      if (existing) {
        await tx.update(linearInstallations)
          .set({ workspaceName: input.workspaceName, connectedBy: caller.userId, updatedAt: now })
          .where(eq(linearInstallations.id, existing.id));
      } else {
        await tx.insert(linearInstallations).values({
          id: `lin_${randomUUID()}`,
          orgId: caller.orgId,
          workspaceId: input.workspaceId,
          workspaceName: input.workspaceName,
          webhookId: null,
          connectedBy: caller.userId,
          createdAt: now,
          updatedAt: now,
        });
      }
      return null;
    }),

    async legacyWebhooks() {
      const installs = await db.select({ webhookId: linearInstallations.webhookId }).from(linearInstallations)
        .where(eq(linearInstallations.orgId, caller.orgId));
      const webhookIds = installs.flatMap((install) => install.webhookId ? [install.webhookId] : []);
      if (webhookIds.length === 0) return null;
      const config = await loadLinearAppConfig(engineCredentials, caller.orgId);
      const credential = await engineCredentials.get(owner, LINEAR_CREDENTIAL_SERVICE);
      if (!config || !credential?.accessToken) return null;
      return { accessToken: credential.accessToken, webhookIds };
    },

    async disconnect() {
      // The app config goes first: a token renewal in flight checks it after
      // its save and removes the token it wrote (linear-app-token-store.ts).
      await engineCredentials.delete(owner, LINEAR_APP_SERVICE);
      await db.delete(linearInstallations).where(eq(linearInstallations.orgId, caller.orgId));
      await engineCredentials.delete(owner, LINEAR_CREDENTIAL_SERVICE);
    },
  };
}

/** The bindings build capabilities through this object. Tests spy on it to
 * prove that a refused request never builds one. The API unit project shares
 * modules between files, so a module mock cannot replace this binding. */
export const linearConnectionAdapter = {
  create: createLinearConnectionCapability,
  endpoints: linearConnectionEndpoints,
};

const connectionBinding = (method: PluginHttpRoute["method"], id: LinearConnectionRouteId): PluginHttpBinding => ({
  method, path: "/connection", auth: "org-admin",
  bind: async ({ providers, request, caller }) => {
    if (!caller) throw new Error("Linear connection routes require an authenticated caller. Check the route authentication.");
    return createLinearConnectionHandlers(
      linearConnectionAdapter.create(providers, caller), linearConnectionAdapter.endpoints(process.env),
    )[id](request);
  },
});

/** The plugin's declared connection handlers answer 501. These bindings serve the routes. */
export const linearHttpBindings: Readonly<Record<LinearConnectionRouteId, PluginHttpBinding>> = {
  "connection-status": connectionBinding("GET", "connection-status"),
  "connection-save": connectionBinding("PUT", "connection-save"),
  "connection-delete": connectionBinding("DELETE", "connection-delete"),
};
