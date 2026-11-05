/**
 * `CredentialStore` port (`@valet/engine`'s `packages/engine/src/types.ts`)
 * implemented over the app Postgres DB (Task 8 of the postgres-backend
 * plan, docs/specs/2026-07-15-postgres-backend-design.md — replaces the
 * sqlite-backed `SqliteCredentialStore`).
 *
 * Backed by the shared `PgQueryable` query interface (decision 4) — every
 * method here is a single statement (`save`'s `ON CONFLICT (owner_type,
 * owner_id, service) DO UPDATE` upsert is one atomic round trip; no
 * multi-statement sequence needs `transaction(fn)`).
 *
 * Secret fields (`accessToken`, `refreshToken`, `apiKey`) are encrypted at
 * rest with `src/lib/secret-crypto.ts`'s AES-256-GCM helpers (byte-identical
 * `v1:{iv}:{tag}:{ct}` format) — the row never holds plaintext.
 * `scopes`/`metadata` are `jsonb` columns (schema/index.ts): written via
 * `jsonbToParam`, read back driver-parsed via `fromJsonbColumn` (both from
 * `@valet/store-postgres` — see their doc comments for the never-re-parse
 * rule).
 */
import { isDeepStrictEqual } from "node:util";
import { CREDENTIAL_INVALIDATION_SQL } from "../services/content-sync/invalidation.js";
import { fromJsonbColumn, jsonbToParam, type PgQueryable } from "@valet/store-postgres";
import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";
import { decryptSecret, encryptSecret } from "../lib/secret-crypto.js";

interface CredentialRow {
  ownerType: string;
  ownerId: string;
  service: string;
  type: StoredCredential["type"];
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  apiKeyEnc: string | null;
  expiresAt: number | null;
  scopes: unknown;
  metadata: unknown;
  createdAt: number;
  updatedAt: number;
}

function toNum(value: unknown, field: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isNaN(n)) throw new Error(`expected numeric value for ${field}, got non-numeric string ${JSON.stringify(value)}`);
    return n;
  }
  throw new Error(`expected numeric value for ${field}, got ${typeof value}`);
}

function toNumOrNull(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : toNum(value, field);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`expected string for ${field}, got ${typeof value}`);
  return value;
}

function asStringOrNull(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : asString(value, field);
}

function rawToCredentialRow(raw: Record<string, unknown>): CredentialRow {
  return {
    ownerType: asString(raw.owner_type, "owner_type"),
    ownerId: asString(raw.owner_id, "owner_id"),
    service: asString(raw.service, "service"),
    type: asString(raw.type, "type") as StoredCredential["type"],
    accessTokenEnc: asStringOrNull(raw.access_token_enc, "access_token_enc"),
    refreshTokenEnc: asStringOrNull(raw.refresh_token_enc, "refresh_token_enc"),
    apiKeyEnc: asStringOrNull(raw.api_key_enc, "api_key_enc"),
    expiresAt: toNumOrNull(raw.expires_at, "expires_at"),
    scopes: raw.scopes,
    metadata: raw.metadata,
    createdAt: toNum(raw.created_at, "created_at"),
    updatedAt: toNum(raw.updated_at, "updated_at"),
  };
}

export class PgCredentialStore implements CredentialStore {
  constructor(
    private readonly db: PgQueryable,
    private readonly key: Buffer,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private encrypt(value: string | undefined): string | null {
    return value === undefined ? null : encryptSecret(value, this.key);
  }

  private decrypt(value: string | null): string | undefined {
    return value === null ? undefined : decryptSecret(value, this.key);
  }

  async get(owner: CredentialOwner, service: string): Promise<StoredCredential | null> {
    const result = await this.db.query(
      `SELECT * FROM credentials WHERE owner_type = $1 AND owner_id = $2 AND service = $3`,
      [owner.type, owner.id, service],
    );
    const raw = result.rows[0];
    if (!raw) return null;
    const row = rawToCredentialRow(raw);
    return this.toCredential(row);
  }

  private toCredential(row: CredentialRow): StoredCredential {
    return {
      type: row.type,
      accessToken: this.decrypt(row.accessTokenEnc),
      refreshToken: this.decrypt(row.refreshTokenEnc),
      apiKey: this.decrypt(row.apiKeyEnc),
      expiresAt: row.expiresAt ?? undefined,
      scopes: fromJsonbColumn<string[]>(row.scopes),
      metadata: fromJsonbColumn<Record<string, unknown>>(row.metadata),
    };
  }

  async save(owner: CredentialOwner, service: string, credential: StoredCredential): Promise<void> {
    const now = this.clock();
    await this.db.query(
      `WITH written AS (INSERT INTO credentials
         (owner_type, owner_id, service, type, access_token_enc, refresh_token_enc, api_key_enc, expires_at, scopes, metadata, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (owner_type, owner_id, service) DO UPDATE SET
         type = EXCLUDED.type,
         access_token_enc = EXCLUDED.access_token_enc,
         refresh_token_enc = EXCLUDED.refresh_token_enc,
         api_key_enc = EXCLUDED.api_key_enc,
         expires_at = EXCLUDED.expires_at,
         scopes = EXCLUDED.scopes,
         metadata = EXCLUDED.metadata,
         updated_at = EXCLUDED.updated_at
       RETURNING owner_type, owner_id, service)
       ${CREDENTIAL_INVALIDATION_SQL}`,
      [
        owner.type,
        owner.id,
        service,
        credential.type,
        this.encrypt(credential.accessToken),
        this.encrypt(credential.refreshToken),
        this.encrypt(credential.apiKey),
        credential.expiresAt ?? null,
        jsonbToParam(credential.scopes),
        jsonbToParam(credential.metadata),
        now,
        now,
      ],
    );
  }

  async compareAndSwap(owner: CredentialOwner, service: string, expected: StoredCredential, next: StoredCredential): Promise<boolean> {
    const result = await this.db.query(
      `SELECT * FROM credentials WHERE owner_type = $1 AND owner_id = $2 AND service = $3`,
      [owner.type, owner.id, service],
    );
    const raw = result.rows[0];
    if (!raw) return false;
    const row = rawToCredentialRow(raw);
    const normalizedExpected: StoredCredential = {
      type: expected.type, accessToken: expected.accessToken, refreshToken: expected.refreshToken,
      apiKey: expected.apiKey, expiresAt: expected.expiresAt, scopes: expected.scopes, metadata: expected.metadata,
    };
    if (!isDeepStrictEqual(this.toCredential(row), normalizedExpected)) return false;
    // Compare the persisted ciphertext snapshot, not newly encrypted expected
    // tokens. Encryption uses random nonces. A concurrent reconnect or delete
    // makes this UPDATE affect zero rows, even when writes share a timestamp.
    const written = await this.db.query(`WITH written AS (
      UPDATE credentials SET type = $4, access_token_enc = $5, refresh_token_enc = $6,
        api_key_enc = $7, expires_at = $8, scopes = $9, metadata = $10, updated_at = $11
      WHERE owner_type = $1 AND owner_id = $2 AND service = $3
        AND type = $12
        AND access_token_enc IS NOT DISTINCT FROM $13
        AND refresh_token_enc IS NOT DISTINCT FROM $14
        AND api_key_enc IS NOT DISTINCT FROM $15
        AND expires_at IS NOT DISTINCT FROM $16
        AND scopes IS NOT DISTINCT FROM $17::jsonb
        AND metadata IS NOT DISTINCT FROM $18::jsonb
        AND updated_at = $19 AND created_at = $20
      RETURNING owner_type, owner_id, service
    ), invalidated AS (${CREDENTIAL_INVALIDATION_SQL} RETURNING source.id)
    SELECT service FROM written`, [
      owner.type, owner.id, service, next.type, this.encrypt(next.accessToken), this.encrypt(next.refreshToken),
      this.encrypt(next.apiKey), next.expiresAt ?? null, jsonbToParam(next.scopes), jsonbToParam(next.metadata), this.clock(),
      row.type, row.accessTokenEnc, row.refreshTokenEnc, row.apiKeyEnc, row.expiresAt,
      jsonbToParam(fromJsonbColumn(row.scopes)), jsonbToParam(fromJsonbColumn(row.metadata)), row.updatedAt, row.createdAt,
    ]);
    return written.rows.length > 0;
  }

  async delete(owner: CredentialOwner, service: string): Promise<void> {
    await this.db.query(`WITH written AS (DELETE FROM credentials WHERE owner_type = $1 AND owner_id = $2 AND service = $3
      RETURNING owner_type, owner_id, service) ${CREDENTIAL_INVALIDATION_SQL}`, [
      owner.type,
      owner.id,
      service,
    ]);
  }

  async list(owner: CredentialOwner): Promise<{ service: string; scopes?: string[]; connectedAt: string }[]> {
    const result = await this.db.query(`SELECT * FROM credentials WHERE owner_type = $1 AND owner_id = $2 ORDER BY created_at ASC`, [
      owner.type,
      owner.id,
    ]);
    return result.rows.map((raw) => {
      const row = rawToCredentialRow(raw);
      return {
        service: row.service,
        scopes: fromJsonbColumn<string[]>(row.scopes),
        connectedAt: new Date(row.createdAt).toISOString(),
      };
    });
  }
}
