import { loadLinearAppConfig, LINEAR_CREDENTIAL_SERVICE } from "./linear-app.js";
import type { CredentialStore } from "@valet/engine";
import { eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { linearInstallations } from "../schema/index.js";
import type { GetLinearConnectionResponse } from "../wire/types.js";

type LinearIngressStatus = Omit<GetLinearConnectionResponse, "redirectUri" | "webhookUrl" | "webhookResourceTypes">;

/** Event ingress uses the organization connection, never a personal MCP connection.
 *
 * Ready means: the org credential and installation row exist for the same
 * Linear workspace, and the credential holds the webhook signing secret. */
export async function getLinearIngressStatus(
  db: AppDb, credentials: CredentialStore, orgId: string,
): Promise<LinearIngressStatus> {
  const [[install], credential, app] = await Promise.all([
    db.select().from(linearInstallations).where(eq(linearInstallations.orgId, orgId)).limit(1),
    credentials.get({ type: "org", id: orgId }, LINEAR_CREDENTIAL_SERVICE),
    loadLinearAppConfig(credentials, orgId),
  ]);
  const configured = app !== null;
  const secret = credential?.metadata?.webhookSecret;
  const webhookConfigured = typeof secret === "string" && !!secret.trim();
  const connected = credential !== null && install !== undefined;
  const workspaceMatches = !credential?.metadata?.workspaceId || credential.metadata.workspaceId === install?.workspaceId;
  const ready = connected && webhookConfigured && workspaceMatches;
  const reason = ready ? undefined : !connected
    ? "Ask an organization admin to connect Linear in Organization settings > Linear. Personal connections only enable tools."
    : "Ask an organization admin to reconnect Linear in Organization settings > Linear to restore event delivery.";
  return {
    configured,
    ...(app ? { clientId: app.clientId } : {}),
    connected,
    webhookConfigured,
    ready,
    ...(install ? { workspaceName: install.workspaceName } : {}),
    ...(reason ? { reason } : {}),
  };
}

export async function linearEventArmBlock(
  db: AppDb, credentials: CredentialStore, orgId: string, eventKeys: readonly string[],
): Promise<string | undefined> {
  if (!eventKeys.some(key => key.startsWith("linear."))) return undefined;
  const status = await getLinearIngressStatus(db,credentials,orgId);
  return status.ready ? undefined : status.reason;
}
