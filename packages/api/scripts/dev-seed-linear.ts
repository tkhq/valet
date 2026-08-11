/**
 * Dev-only seed: a fake Linear installation + webhook credential for the
 * stub org, so signed webhooks can be sent to POST /webhooks/events/linear
 * locally. Run with the api STOPPED (it owns ~/.valet/pg):
 *
 *   cd packages/api && npx tsx scripts/dev-seed-linear.ts
 */
import { PGlite } from "@electric-sql/pglite";
import { PgCredentialStore } from "../src/plugins/credential-store.js";
import { deriveSecretKey } from "../src/lib/secret-crypto.js";

const ORG_ID = "local-org";
const WORKSPACE_ID = "ws-dev-seed";
export const DEV_WEBHOOK_SECRET = "dev-webhook-secret";

const dataDir = `${process.env.HOME}/.valet/pg`;
const db = new PGlite(dataDir);
await db.waitReady;

const key = deriveSecretKey(process.env.VALET_ENCRYPTION_KEY ?? "dev-key-not-secure");
// PGlite's query() lacks the rowCount field PgQueryable requires; adapt.
const store = new PgCredentialStore(
  {
    query: async (sql: string, params?: unknown[]) => {
      const result = await db.query<Record<string, unknown>>(sql, params);
      return { rows: result.rows, rowCount: result.rows.length };
    },
  },
  key,
);

const now = Date.now();
await db.query(
  `INSERT INTO linear_installations
     (id, org_id, workspace_id, workspace_name, webhook_id, connected_by, created_at, updated_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
   ON CONFLICT (id) DO NOTHING`,
  ["li_dev_seed", ORG_ID, WORKSPACE_ID, "Dev Seed Workspace", null, "local-user", now, now],
);

await store.save({ type: "org", id: ORG_ID }, "linear", {
  type: "oauth2",
  accessToken: "dev-stub-token",
  metadata: { webhookSecret: DEV_WEBHOOK_SECRET, workspaceId: WORKSPACE_ID },
});

console.log(`seeded: workspace ${WORKSPACE_ID} -> org ${ORG_ID}, webhook secret "${DEV_WEBHOOK_SECRET}"`);
await db.close();
