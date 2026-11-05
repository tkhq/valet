import { and, eq } from 'drizzle-orm';
import type { AppDb } from '../lib/drizzle.js';
import { isRecord } from '../lib/oauth-state.js';
import { credentials, linearInstallations } from '../schema/index.js';
import { LINEAR_CREDENTIAL_SERVICE } from '../services/linear-app.js';
import { writeDropLog } from '../orchestrator/signals.js';

export interface HttpInstallation {
  orgId: string;
  secrets: Record<string, string>;
}

/** Compatibility adapter for existing installations, pending plugin-owned storage. */
export const httpInstallationResolvers: Readonly<Record<string, (db: AppDb, externalId: string) => Promise<HttpInstallation | null>>> = {
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
