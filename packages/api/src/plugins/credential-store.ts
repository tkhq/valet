/**
 * `CredentialStore` port (`@valet/engine`'s `packages/engine/src/types.ts`)
 * implemented over the app sqlite DB (plugin-system-v2 plan Task 3).
 *
 * Backed by the raw better-sqlite3 handle underneath the app's Drizzle
 * instance (`AppDb["$client"]`) — mirrors `packages/api/src/workflows/
 * sqlite-store.ts`'s house idiom: prepared statements, single conditional
 * upserts, JSON-text columns for `scopes`/`metadata`.
 *
 * Secret fields (`accessToken`, `refreshToken`, `apiKey`) are encrypted at
 * rest with `src/lib/secret-crypto.ts`'s AES-256-GCM helpers — the sqlite
 * row never holds plaintext.
 */
import type Database from "better-sqlite3";
import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { decryptSecret, encryptSecret } from "../lib/secret-crypto.js";

interface CredentialRow {
  owner_type: string;
  owner_id: string;
  service: string;
  type: StoredCredential["type"];
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  api_key_enc: string | null;
  expires_at: number | null;
  scopes: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

export class SqliteCredentialStore implements CredentialStore {
  private readonly sqlite: Database.Database;

  constructor(
    db: AppDb & { $client: Database.Database },
    private readonly key: Buffer,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.sqlite = db.$client;
  }

  private encrypt(value: string | undefined): string | null {
    return value === undefined ? null : encryptSecret(value, this.key);
  }

  private decrypt(value: string | null): string | undefined {
    return value === null ? undefined : decryptSecret(value, this.key);
  }

  async get(owner: CredentialOwner, service: string): Promise<StoredCredential | null> {
    const row = this.sqlite
      .prepare(`SELECT * FROM credentials WHERE owner_type = ? AND owner_id = ? AND service = ?`)
      .get(owner.type, owner.id, service) as CredentialRow | undefined;
    if (!row) return null;
    return {
      type: row.type,
      accessToken: this.decrypt(row.access_token_enc),
      refreshToken: this.decrypt(row.refresh_token_enc),
      apiKey: this.decrypt(row.api_key_enc),
      expiresAt: row.expires_at ?? undefined,
      scopes: row.scopes === null ? undefined : (JSON.parse(row.scopes) as string[]),
      metadata: row.metadata === null ? undefined : (JSON.parse(row.metadata) as Record<string, unknown>),
    };
  }

  async save(owner: CredentialOwner, service: string, credential: StoredCredential): Promise<void> {
    const now = this.clock();
    this.sqlite
      .prepare(
        `INSERT INTO credentials
           (owner_type, owner_id, service, type, access_token_enc, refresh_token_enc, api_key_enc, expires_at, scopes, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_type, owner_id, service) DO UPDATE SET
           type = excluded.type,
           access_token_enc = excluded.access_token_enc,
           refresh_token_enc = excluded.refresh_token_enc,
           api_key_enc = excluded.api_key_enc,
           expires_at = excluded.expires_at,
           scopes = excluded.scopes,
           metadata = excluded.metadata,
           updated_at = excluded.updated_at`,
      )
      .run(
        owner.type,
        owner.id,
        service,
        credential.type,
        this.encrypt(credential.accessToken),
        this.encrypt(credential.refreshToken),
        this.encrypt(credential.apiKey),
        credential.expiresAt ?? null,
        credential.scopes === undefined ? null : JSON.stringify(credential.scopes),
        credential.metadata === undefined ? null : JSON.stringify(credential.metadata),
        now,
        now,
      );
  }

  async delete(owner: CredentialOwner, service: string): Promise<void> {
    this.sqlite
      .prepare(`DELETE FROM credentials WHERE owner_type = ? AND owner_id = ? AND service = ?`)
      .run(owner.type, owner.id, service);
  }

  async list(owner: CredentialOwner): Promise<{ service: string; scopes?: string[]; connectedAt: string }[]> {
    const rows = this.sqlite
      .prepare(`SELECT * FROM credentials WHERE owner_type = ? AND owner_id = ? ORDER BY created_at ASC`)
      .all(owner.type, owner.id) as CredentialRow[];
    return rows.map((row) => ({
      service: row.service,
      scopes: row.scopes === null ? undefined : (JSON.parse(row.scopes) as string[]),
      connectedAt: new Date(row.created_at).toISOString(),
    }));
  }
}
