/**
 * Per-engagement credential vault (Part 10 spec).
 *
 * One row per credential a user provisions for a security engagement, at
 * rest as `v1:{iv}:{tag}:{ct}` keyed off `VALET_ENCRYPTION_KEY`. The row
 * carries a fingerprint the tripwire scans for. `owner_user_id` names the
 * ONLY reader; every read stamps `engagement_credential_access`.
 *
 * The value ONLY appears:
 *   1. In the request body of `POST /security/vault` (TLS in transit;
 *      never persisted in a route buffer past the encrypt call).
 *   2. As a Buffer inside `materialize()` for the duration of the sandbox
 *      mint — the caller MUST zero the buffer via `zeroMaterialized()`.
 *
 * The value NEVER appears in `engine_entries`, WS frames, reports, findings,
 * incident rows, metric labels, or logs. INV-12..INV-17.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";

import type { AppDb } from "../lib/drizzle.js";
import {
  agentSessions,
  engagementCredentialAccess,
  engagementCredentials,
  type EngagementCredentialAccessRow,
  type EngagementCredentialRow,
  securityEngagements,
  securityIncidents,
  type SecurityIncidentRow,
} from "../schema/index.js";
import {
  decryptSecretBuffer,
  encryptSecretBuffer,
} from "../lib/secret-crypto.js";
import {
  recordVaultCredentialMaterialized,
  recordVaultCredentialWritten,
  recordVaultShred,
  recordVaultTripwireHit,
} from "../observability/security-metrics.js";

// ── Config ────────────────────────────────────────────────────────────────

/** How the persona-side file body is composed for each Credential kind.
 * Personas read the file at `/etc/valet/creds/vault/<label>[.<ext>]`. */
export const CREDENTIAL_KINDS = [
  "password",
  "session",
  "headerToken",
  "mtls",
  "signingKey",
  "toolAuth",
  "testData",
] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/** Default TTL after which a credential's ciphertext is DELETEd if it has
 * not been used. Overridable per row via `expires_at`. */
export const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Max characters we accept in a single-value credential body across the
 * wire. Compressed cert bundles and cookie jars stay within this. Larger
 * blobs are rejected with a corrective error. */
export const MAX_CREDENTIAL_VALUE_BYTES = 128 * 1024;

/** Max characters we accept in the label. */
export const MAX_LABEL_CHARS = 128;

/** How the tripwire's fingerprint is derived from the value bytes. */
function fingerprintOf(value: Buffer): string {
  const digest = createHash("sha256").update(value).digest();
  // 16 bytes is the "few-collision" tradeoff Part 10 pins; base64url so it
  // rides in a JSON body without escaping.
  return digest.subarray(0, 16).toString("base64url");
}

// ── Public shapes ─────────────────────────────────────────────────────────

export interface WriteCredentialInput {
  engagementId: string;
  ownerUserId: string;
  label: string;
  kind: CredentialKind;
  meta?: Record<string, unknown>;
  value: string | Buffer;
  expiresAt?: number;
}

/** The safe-to-return projection of a credential row (owner view). Never
 * carries `ciphertext` or `fingerprint`. */
export interface CredentialSummary {
  id: string;
  engagementId: string;
  label: string;
  kind: CredentialKind;
  meta: Record<string, unknown>;
  createdAt: number;
  lastUsedAt: number | null;
  deadAt: number | null;
  deadReason: string | null;
  expiresAt: number | null;
}

/** A materialized credential handed to `buildSandboxMint`. `body` is a
 * Buffer the caller MUST zero via `materialization.dispose()` after the
 * sandbox mint finishes. `filePath` is the path the persona reads inside
 * the sandbox. `credsFileName` is the plain filename the sandbox provider
 * consumes (`credsFiles: Record<filename, string>`). */
export interface MaterializedCredential {
  credentialId: string;
  label: string;
  kind: CredentialKind;
  meta: Record<string, unknown>;
  body: Buffer;
  filePath: string;
  credsFileName: string;
}

export interface Materialization {
  entries: MaterializedCredential[];
  /** Zeros every entry's body buffer AND stamps `released_at` on every
   * access-log row this materialize opened. MUST be called by the caller
   * once the mint has consumed the buffers (they land in `credsFiles`
   * which base64-encodes them into the api-side write). */
  dispose: () => Promise<void>;
}

/** A per-engagement snapshot of the tripwire index the bridge and the
 * thread persist paths consult. `values` are the raw plaintext bytes;
 * every returned `Snapshot` carries a `dispose` that MUST zero the
 * bytes. Callers hold the snapshot for one dispatch window and no
 * longer. */
export interface TripwireIndexSnapshot {
  entries: TripwireIndexEntry[];
  dispose: () => void;
}

export interface TripwireIndexEntry {
  credentialId: string;
  label: string;
  fingerprint: string;
  /** Byte substrings we scan for. Includes the raw value, a base64url
   * encoding, and a percent-encoded form so a URL-embedded copy is
   * caught. Callers MUST NOT log or store these. */
  matchBytes: Buffer[];
}

// ── Errors ────────────────────────────────────────────────────────────────

export class VaultOwnerViolationError extends Error {
  constructor(ownerUserId: string) {
    super(
      `Only the engagement's creator (${ownerUserId}) can view or edit this vault. Ask them to open it, or start your own review.`,
    );
    this.name = "VaultOwnerViolationError";
  }
}

export class VaultLabelDuplicateError extends Error {
  constructor(label: string) {
    super(
      `A credential labeled "${label}" already exists on this engagement. Delete the old one first, or pick a different label.`,
    );
    this.name = "VaultLabelDuplicateError";
  }
}

export class VaultCredentialNotFoundError extends Error {
  constructor(credentialId: string) {
    super(
      `No credential ${credentialId} in this engagement's vault. List the vault to see which ids exist.`,
    );
    this.name = "VaultCredentialNotFoundError";
  }
}

export class VaultKekMismatchError extends Error {
  constructor(rowKekId: string, currentKekId: string) {
    super(
      `This credential was encrypted under key id ${rowKekId}; this environment carries ${currentKekId}. Restore the matching key or re-provision.`,
    );
    this.name = "VaultKekMismatchError";
  }
}

export class VaultValueTooLargeError extends Error {
  constructor(seenBytes: number) {
    super(
      `Credential value is ${seenBytes} bytes; the vault accepts up to ${MAX_CREDENTIAL_VALUE_BYTES}. Trim the value or split the payload.`,
    );
    this.name = "VaultValueTooLargeError";
  }
}

// ── Service ───────────────────────────────────────────────────────────────

export interface EngagementVaultDeps {
  db: AppDb;
  /** Derived key from `VALET_ENCRYPTION_KEY` (or a rotated equivalent).
   * The service treats it as opaque — never logs, never re-derives. */
  key: Buffer;
  /** Env-stamped identifier the row carries. A restore into a mismatched
   * environment fails at decrypt (INV-16). */
  kekId: string;
  now?: () => number;
}

export function createEngagementVault(deps: EngagementVaultDeps) {
  const { db, key, kekId } = deps;
  const now = deps.now ?? Date.now;

  async function assertOwner(
    engagementId: string,
    requesterUserId: string,
  ): Promise<{ ownerUserId: string }> {
    const rows = await db
      .select({ userId: agentSessions.userId })
      .from(securityEngagements)
      .innerJoin(agentSessions, eq(agentSessions.id, securityEngagements.sessionId))
      .where(eq(securityEngagements.id, engagementId))
      .limit(1);
    const owner = rows[0]?.userId;
    if (!owner) {
      throw new Error(
        `No engagement ${engagementId}. Check the id with sec_status.`,
      );
    }
    if (owner !== requesterUserId) {
      throw new VaultOwnerViolationError(owner);
    }
    return { ownerUserId: owner };
  }

  async function ownerOf(engagementId: string): Promise<string | null> {
    const rows = await db
      .select({ userId: agentSessions.userId })
      .from(securityEngagements)
      .innerJoin(agentSessions, eq(agentSessions.id, securityEngagements.sessionId))
      .where(eq(securityEngagements.id, engagementId))
      .limit(1);
    return rows[0]?.userId ?? null;
  }

  function projectRow(row: EngagementCredentialRow): CredentialSummary {
    return {
      id: row.id,
      engagementId: row.engagementId,
      label: row.label,
      kind: row.kind as CredentialKind,
      meta: safeParseMeta(row.metaJson),
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt ?? null,
      deadAt: row.deadAt ?? null,
      deadReason: row.deadReason ?? null,
      expiresAt: row.expiresAt ?? null,
    };
  }

  function fileExtFor(kind: CredentialKind): string {
    switch (kind) {
      case "mtls":
      case "signingKey":
        return ".pem";
      case "session":
        return ".txt";
      default:
        return ".json";
    }
  }

  /** Flat filename under /etc/valet/creds/. The sandbox providers accept
   * plain filenames only (no path traversal, no subdirectories), so vault
   * entries land as `vault-<safe-label>.<ext>`. The persona reads
   * `/etc/valet/creds/vault-<safe-label>.<ext>`. */
  function credsFileName(label: string, kind: CredentialKind): string {
    const safe = label.replace(/[^A-Za-z0-9_.-]+/g, "_");
    return `vault-${safe}${fileExtFor(kind)}`;
  }

  function filePathFor(label: string, kind: CredentialKind): string {
    return `/etc/valet/creds/${credsFileName(label, kind)}`;
  }

  /** Composes the file body a persona reads inside the sandbox. For most
   * kinds this is JSON of the non-value fields plus the value; for a raw
   * PEM or a cookie jar we pass through bytes. Returns a fresh Buffer;
   * the caller owns its lifecycle (zero after consumption). */
  function composeFileBody(
    kind: CredentialKind,
    meta: Record<string, unknown>,
    value: Buffer,
  ): Buffer {
    if (kind === "session") return Buffer.from(value); // jar bytes, unchanged
    if (kind === "mtls" || kind === "signingKey") return Buffer.from(value); // PEM bytes
    // Everything else JSON-embeds the value alongside meta. We build the
    // outer JSON as string prefix + inline value + suffix so the value
    // buffer is copied only into the outbound buffer.
    const outer = { ...meta, value: value.toString("utf8") };
    return Buffer.from(JSON.stringify(outer), "utf8");
  }

  /** Write a credential to the vault. The value bytes are encrypted at the
   * boundary; the incoming Buffer or String is zeroed by the caller. */
  async function writeCredential(input: WriteCredentialInput): Promise<CredentialSummary> {
    if (input.label.trim() === "" || input.label.length > MAX_LABEL_CHARS) {
      throw new Error(
        `A credential label must be 1..${MAX_LABEL_CHARS} characters. Give a short handle a persona can reference.`,
      );
    }
    if (!CREDENTIAL_KINDS.includes(input.kind)) {
      throw new Error(
        `Credential kind must be one of ${CREDENTIAL_KINDS.join(", ")}. Pick the one whose fields match your secret.`,
      );
    }
    const valueBuf =
      typeof input.value === "string"
        ? Buffer.from(input.value, "utf8")
        : Buffer.from(input.value);
    try {
      if (valueBuf.length === 0) {
        throw new Error(
          `A credential value cannot be empty. Provide the secret bytes.`,
        );
      }
      if (valueBuf.length > MAX_CREDENTIAL_VALUE_BYTES) {
        throw new VaultValueTooLargeError(valueBuf.length);
      }
      const ciphertext = encryptSecretBuffer(valueBuf, key);
      const fingerprint = fingerprintOf(valueBuf);
      const id = `ec_${randomUUID().replace(/-/g, "")}`;
      const createdAt = now();
      const expiresAt = input.expiresAt ?? createdAt + DEFAULT_TTL_MS;
      try {
        const inserted = await db
          .insert(engagementCredentials)
          .values({
            id,
            engagementId: input.engagementId,
            ownerUserId: input.ownerUserId,
            label: input.label,
            kind: input.kind,
            metaJson: JSON.stringify(input.meta ?? {}),
            ciphertext,
            kekId,
            fingerprint,
            createdAt,
            expiresAt,
          })
          .returning();
        recordVaultCredentialWritten(input.kind);
        return projectRow(inserted[0]);
      } catch (err) {
        // Postgres duplicate-key surfaces as a driver error whose message
        // mentions the unique index. Translate to the corrective error.
        const message = err instanceof Error ? err.message : String(err);
        if (
          message.includes("engagement_credentials_engagement_label_unique") ||
          message.toLowerCase().includes("unique") ||
          message.toLowerCase().includes("duplicate")
        ) {
          throw new VaultLabelDuplicateError(input.label);
        }
        throw err;
      }
    } finally {
      valueBuf.fill(0);
    }
  }

  /** Owner-scoped listing. Every read is stamped in the audit table by the
   * route layer via `recordAccessCheck` (not here — this is a listing, not
   * a materialize; audit is only for value-touching reads). */
  async function listCredentials(
    engagementId: string,
    requesterUserId: string,
  ): Promise<CredentialSummary[]> {
    await assertOwner(engagementId, requesterUserId);
    const rows = await db
      .select()
      .from(engagementCredentials)
      .where(eq(engagementCredentials.engagementId, engagementId));
    return rows.map(projectRow);
  }

  /** Non-owner view: only the vault size. The route layer uses this to
   * render "N credentials in the vault; owner: <handle>". */
  async function countCredentials(engagementId: string): Promise<number> {
    const rows = await db
      .select({ id: engagementCredentials.id })
      .from(engagementCredentials)
      .where(eq(engagementCredentials.engagementId, engagementId));
    return rows.length;
  }

  /** Owner-scoped hard delete (crypto-shred; the row is gone). */
  async function deleteCredential(
    credentialId: string,
    requesterUserId: string,
  ): Promise<void> {
    const rows = await db
      .select()
      .from(engagementCredentials)
      .where(eq(engagementCredentials.id, credentialId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new VaultCredentialNotFoundError(credentialId);
    await assertOwner(row.engagementId, requesterUserId);
    await db
      .delete(engagementCredentials)
      .where(eq(engagementCredentials.id, credentialId));
    recordVaultShred("manual");
  }

  /** Owner-scoped access-log listing for one credential. Never returns
   * the value or the fingerprint. */
  async function listAccess(
    credentialId: string,
    requesterUserId: string,
  ): Promise<EngagementCredentialAccessRow[]> {
    const rows = await db
      .select()
      .from(engagementCredentials)
      .where(eq(engagementCredentials.id, credentialId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new VaultCredentialNotFoundError(credentialId);
    await assertOwner(row.engagementId, requesterUserId);
    return db
      .select()
      .from(engagementCredentialAccess)
      .where(eq(engagementCredentialAccess.credentialId, credentialId));
  }

  /**
   * Decrypt every credential the caller names, project it into a sandbox-
   * ready file body, and stamp `engagement_credential_access`. The
   * `dispose()` handle zeros every returned Buffer AND stamps
   * `released_at` on every access row this call opened.
   *
   * `labels` is what the persona's playbook / cell dispatch prompt names.
   * Unknown labels are silently skipped (a plan may reference credentials
   * that were later deleted). Dead / expired rows are also skipped.
   */
  async function materialize(args: {
    engagementId: string;
    cellId: string;
    sandboxId?: string;
    labels: string[];
  }): Promise<Materialization> {
    if (args.labels.length === 0) {
      return { entries: [], dispose: async () => {} };
    }
    const rows = await db
      .select()
      .from(engagementCredentials)
      .where(
        and(
          eq(engagementCredentials.engagementId, args.engagementId),
          inArray(engagementCredentials.label, args.labels),
          isNull(engagementCredentials.deadAt),
        ),
      );
    const entries: MaterializedCredential[] = [];
    const accessIds: string[] = [];
    const dispatchedAt = now();
    for (const row of rows) {
      if (row.kekId !== kekId) {
        // Row was encrypted under a different key; don't decrypt, mark
        // dead so the owner sees why.
        await db
          .update(engagementCredentials)
          .set({ deadAt: dispatchedAt, deadReason: `kek mismatch (${row.kekId})` })
          .where(eq(engagementCredentials.id, row.id));
        continue;
      }
      const valueBuf = decryptSecretBuffer(row.ciphertext, key);
      const meta = safeParseMeta(row.metaJson);
      const kind = row.kind as CredentialKind;
      const body = composeFileBody(kind, meta, valueBuf);
      valueBuf.fill(0);
      entries.push({
        credentialId: row.id,
        label: row.label,
        kind,
        meta,
        body,
        filePath: filePathFor(row.label, kind),
        credsFileName: credsFileName(row.label, kind),
      });
      recordVaultCredentialMaterialized(kind);
      const accessId = `eca_${randomUUID().replace(/-/g, "")}`;
      accessIds.push(accessId);
      await db.insert(engagementCredentialAccess).values({
        id: accessId,
        credentialId: row.id,
        engagementId: args.engagementId,
        cellId: args.cellId,
        sandboxId: args.sandboxId ?? null,
        dispatchedAt,
      });
      await db
        .update(engagementCredentials)
        .set({ lastUsedAt: dispatchedAt })
        .where(eq(engagementCredentials.id, row.id));
    }
    return {
      entries,
      dispose: async () => {
        for (const e of entries) e.body.fill(0);
        if (accessIds.length > 0) {
          await db
            .update(engagementCredentialAccess)
            .set({ releasedAt: now() })
            .where(inArray(engagementCredentialAccess.id, accessIds));
        }
      },
    };
  }

  /** Build the per-engagement tripwire snapshot. Values are decrypted
   * into Buffers held in `matchBytes`. `dispose()` zeros every match
   * substring. Callers use this for the persist + send seams and MUST
   * dispose it. */
  async function tripwireIndex(engagementId: string): Promise<TripwireIndexSnapshot> {
    const rows = await db
      .select()
      .from(engagementCredentials)
      .where(
        and(
          eq(engagementCredentials.engagementId, engagementId),
          isNull(engagementCredentials.deadAt),
        ),
      );
    const entries: TripwireIndexEntry[] = [];
    const allBuffers: Buffer[] = [];
    for (const row of rows) {
      if (row.kekId !== kekId) continue;
      const valueBuf = decryptSecretBuffer(row.ciphertext, key);
      // Three shapes so the scanner catches the raw form, an
      // Authorization-header variant, and a URL-embedded form.
      const raw = Buffer.from(valueBuf);
      const b64 = Buffer.from(valueBuf.toString("base64url"), "utf8");
      const urlEncoded = Buffer.from(encodeURIComponent(valueBuf.toString("utf8")), "utf8");
      valueBuf.fill(0);
      const matchBytes = [raw, b64, urlEncoded].filter(
        (b) => b.length >= 8, // avoid trivial matches
      );
      allBuffers.push(...matchBytes);
      entries.push({
        credentialId: row.id,
        label: row.label,
        fingerprint: row.fingerprint,
        matchBytes,
      });
    }
    return {
      entries,
      dispose: () => {
        for (const b of allBuffers) b.fill(0);
      },
    };
  }

  /** Record a tripwire hit. Called by the persist / send / egress seams
   * when a match is detected. */
  async function recordIncident(input: {
    engagementId: string;
    cellId?: string | null;
    credentialId?: string | null;
    credentialLabel?: string | null;
    seam: "persist" | "send" | "egress";
    quarantinedEntryId?: string | null;
  }): Promise<SecurityIncidentRow> {
    const id = `sinc_${randomUUID().replace(/-/g, "")}`;
    const detectedAt = now();
    const inserted = await db
      .insert(securityIncidents)
      .values({
        id,
        engagementId: input.engagementId,
        cellId: input.cellId ?? null,
        credentialId: input.credentialId ?? null,
        credentialLabel: input.credentialLabel ?? null,
        seam: input.seam,
        quarantinedEntryId: input.quarantinedEntryId ?? null,
        detectedAt,
      })
      .returning();
    recordVaultTripwireHit(input.seam);
    return inserted[0];
  }

  /** Sweep TTL. Called from a periodic job. Returns the number of rows
   * crypto-shredded. */
  async function sweepExpired(): Promise<number> {
    const cutoff = now();
    const deleted = await db
      .delete(engagementCredentials)
      .where(lt(engagementCredentials.expiresAt, cutoff))
      .returning({ id: engagementCredentials.id });
    for (let i = 0; i < deleted.length; i++) recordVaultShred("ttl");
    return deleted.length;
  }

  /** Purge every credential for an engagement. Called on cancel + on
   * engagement delete. Idempotent. */
  async function purgeEngagement(engagementId: string): Promise<number> {
    const deleted = await db
      .delete(engagementCredentials)
      .where(eq(engagementCredentials.engagementId, engagementId))
      .returning({ id: engagementCredentials.id });
    for (let i = 0; i < deleted.length; i++) recordVaultShred("cancel");
    return deleted.length;
  }

  return {
    writeCredential,
    listCredentials,
    countCredentials,
    deleteCredential,
    listAccess,
    materialize,
    tripwireIndex,
    recordIncident,
    sweepExpired,
    purgeEngagement,
    ownerOf,
    // Exposed for testing / for the routes that pre-flight a permission check
    // before hitting the vault (owner-view metadata endpoints).
    assertOwner,
  };
}

export type EngagementVault = ReturnType<typeof createEngagementVault>;

function safeParseMeta(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
