import { and, eq } from 'drizzle-orm';
import type { AppDb } from '../lib/drizzle.js';
import { isRecord } from '../lib/oauth-state.js';
import { decryptSecret, deriveSecretKey } from '../lib/secret-crypto.js';
import { credentials, linearInstallations, orgs } from '../schema/index.js';
import { isGranolaSigningSecret } from '@valet/plugin-granola/triggers';
import { LINEAR_CREDENTIAL_SERVICE } from '../services/linear-app.js';
import { writeDropLog } from '../orchestrator/signals.js';

/**
 * The installation exists or may exist, but its signing secret cannot be read.
 * The route answers 503 and drop-logs `orgId` when it is set. A 503 is a
 * retryable status for providers that retry 5xx, so deliveries that arrive
 * before an admin fixes the setup are not lost. Linear's resolver returns null
 * instead, because an unknown workspace is not a setup fault.
 */
export class HttpInstallationUnavailable extends Error {
  constructor(readonly orgId: string | undefined, readonly detail: string) {
    super(detail);
  }
}

export interface HttpInstallation {
  orgId: string;
  secrets: Record<string, string>;
}

/** Compatibility adapter for existing installations, pending plugin-owned storage. */
/** The org credential that holds a Granola webhook signing secret. Not `granola`: that service is the personal MCP token. */
export const GRANOLA_WEBHOOK_CREDENTIAL_SERVICE = 'granola-webhook';

export const httpInstallationResolvers: Readonly<Record<string, (db: AppDb, externalId: string, encryptionKey: string) => Promise<HttpInstallation | null>>> = {
  granola: async (db, externalId, encryptionKey) => {
    // The URL names a candidate organization. It authorizes nothing until the
    // route verifies the signature with that organization's secret.
    const [credential] = await db.select({
      type: credentials.type, apiKeyEnc: credentials.apiKeyEnc, metadata: credentials.metadata,
    }).from(credentials)
      .where(and(eq(credentials.ownerType, 'org'), eq(credentials.ownerId, externalId), eq(credentials.service, GRANOLA_WEBHOOK_CREDENTIAL_SERVICE))).limit(1);
    if (!credential) {
      // Log only for a real organization, so a caller cannot fill the log under invented IDs.
      const [org] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, externalId)).limit(1);
      throw new HttpInstallationUnavailable(org?.id, 'A Granola delivery arrived but no signing secret is saved. Save the webhook signing secret with PUT /api/credentials/granola-webhook. Granola retries for up to four days.');
    }
    // Only a direct API key is readable here. A 1Password reference or a bot
    // token would need a live resolver call for every unsigned request.
    const unreadable = credential.type !== 'api_key' || !credential.apiKeyEnc || (isRecord(credential.metadata) && 'onepassword' in credential.metadata);
    let secret: string | undefined;
    if (!unreadable) {
      try { secret = decryptSecret(credential.apiKeyEnc!, deriveSecretKey(encryptionKey)); } catch { secret = undefined; }
    }
    if (!secret) {
      throw new HttpInstallationUnavailable(externalId, 'The saved Granola signing secret cannot be read. Save it again as a direct api_key with PUT /api/credentials/granola-webhook. A 1Password reference or bot_token is not supported.');
    }
    return { orgId: externalId, secrets: { signingSecret: secret } };
  },
  linear: async (db, externalId) => {
    // A provider workspace identifies a candidate tenant. It authorizes nothing
    // until the route verifies the signature with this installation's secret.
    const [installation] = await db.select({ orgId: linearInstallations.orgId }).from(linearInstallations)
      .where(eq(linearInstallations.workspaceId, externalId)).limit(1);
    if (!installation) return null;
    const { orgId } = installation;
    // Do not use engineCredentials: an unsigned delivery must not refresh tokens.
    const [credential] = await db.select({ metadata: credentials.metadata }).from(credentials)
      .where(and(eq(credentials.ownerType, 'org'), eq(credentials.ownerId, orgId), eq(credentials.service, LINEAR_CREDENTIAL_SERVICE))).limit(1);
    const metadata = isRecord(credential?.metadata) ? credential.metadata : {};
    if (typeof metadata.webhookSecret !== 'string' || !metadata.webhookSecret) {
      await writeDropLog(db, { orgId, reason: 'unknown_org', detail: `linear webhook for ${externalId}: no credential` });
      return null;
    }
    return { orgId, secrets: { webhookSecret: metadata.webhookSecret } };
  },
};
