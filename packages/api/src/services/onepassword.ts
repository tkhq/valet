/**
 * 1Password service module — the ONLY file in this codebase that imports
 * `@1password/sdk` (mirrors the isolation in the legacy
 * `packages/runner/src/onepassword-provider.ts`). Owns:
 *
 *   - SDK client construction + adaptation into the narrow `OpClient` shape
 *     this module needs (`defaultCreateClient`), with per-token memoization.
 *   - Service-account token lookup: org token from the org-owned
 *     `onepassword` credential row, personal token from the session user's
 *     user-owned row (reserved service name `ONEPASSWORD_SERVICE`).
 *   - `resolveReference`: the resolve-cache seam (5-minute TTL), keyed by
 *     scope + token owner + reference.
 *   - `resolveCredential`: the resolver-seam entry point — turns a
 *     reference-carrying `StoredCredential` (`metadata.onepassword`) into a
 *     synthesized credential with the secret filled per `type`
 *     (`api_key` → `apiKey`, anything else incl. `oauth2` → `accessToken`).
 *     Rows without `metadata.onepassword` pass through unchanged (same
 *     object, no clone) — byte-identical to today for non-1Password rows.
 *
 * No secret material ever appears in an `OnePasswordAuthError` message —
 * only the reference and the owning scope/token gap.
 */

import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";

/** Reserved credential service name for 1Password service-account tokens. */
export const ONEPASSWORD_SERVICE = "onepassword";

const RESOLVE_TTL_MS = 5 * 60_000;

// ── Public shapes ──────────────────────────────────────────────────────

export interface OpVault {
  id: string;
  title: string;
}

export interface OpItem {
  id: string;
  title: string;
  vaultId: string;
}

export interface OpItemField {
  id: string;
  title: string;
  fieldType: string;
}

export interface OpItemDetail {
  id: string;
  title: string;
  fields: OpItemField[];
}

/** Narrow view of @1password/sdk's client — the only shape this module needs. */
export interface OpClient {
  secrets: { resolve(reference: string): Promise<string> };
  vaults: { list(): Promise<OpVault[]> };
  items: {
    list(vaultId: string): Promise<OpItem[]>;
    get(vaultId: string, itemId: string): Promise<OpItemDetail>;
  };
}

export type OnePasswordScope = "org" | "personal";

export interface OnePasswordCtx {
  orgId: string;
  userId: string;
}

export class OnePasswordAuthError extends Error {}

export interface OnePasswordDeps {
  credentials: CredentialStore;
  getAllowPersonal: (orgId: string) => Promise<boolean>;
  /** Default: real SDK (lazy import), adapted into `OpClient`. */
  createClient?: (token: string) => Promise<OpClient>;
  /** Default: `Date.now`. Injectable for cache-TTL tests. */
  now?: () => number;
}

export interface OnePasswordService {
  tokenConnected(scope: OnePasswordScope, ctx: OnePasswordCtx): Promise<boolean>;
  listVaults(scope: OnePasswordScope, ctx: OnePasswordCtx): Promise<OpVault[]>;
  listItems(scope: OnePasswordScope, ctx: OnePasswordCtx, vaultId: string): Promise<OpItem[]>;
  getItem(
    scope: OnePasswordScope,
    ctx: OnePasswordCtx,
    vaultId: string,
    itemId: string,
  ): Promise<OpItemDetail>;
  resolveReference(scope: OnePasswordScope, ctx: OnePasswordCtx, reference: string): Promise<string>;
  /** The resolver-seam entry: fills the secret into a reference-carrying row. */
  resolveCredential(row: StoredCredential, ctx: OnePasswordCtx): Promise<StoredCredential>;
}

// ── 1Password reference metadata on a StoredCredential ──────────────────

interface OnePasswordMeta {
  reference: string;
  tokenScope: OnePasswordScope;
}

/** Type guard used by host + routes. */
export function onePasswordMeta(row: StoredCredential): OnePasswordMeta | null {
  const meta = row.metadata?.onepassword;
  if (!meta || typeof meta !== "object") return null;
  // `metadata` is `Record<string, unknown>`; narrowed to `object` above, so
  // this only widens the index signature to read named properties — no
  // shape is assumed until the `typeof`/enum checks below pass.
  const candidate = meta as Record<string, unknown>;
  const { reference, tokenScope } = candidate;
  if (typeof reference !== "string") return null;
  if (tokenScope !== "org" && tokenScope !== "personal") return null;
  return { reference, tokenScope };
}

// ── Default SDK adapter ──────────────────────────────────────────────────

async function defaultCreateClient(token: string): Promise<OpClient> {
  const sdk = await import("@1password/sdk");
  const client = await sdk.createClient({
    auth: token,
    integrationName: "Valet",
    integrationVersion: "2.0.0",
  });
  return {
    secrets: {
      resolve: (reference: string) => client.secrets.resolve(reference),
    },
    vaults: {
      list: async () => {
        const vaults = await client.vaults.list();
        return vaults.map((v) => ({ id: v.id, title: v.title }));
      },
    },
    items: {
      list: async (vaultId: string) => {
        const items = await client.items.list(vaultId);
        return items.map((i) => ({ id: i.id, title: i.title, vaultId: i.vaultId }));
      },
      get: async (vaultId: string, itemId: string) => {
        const item = await client.items.get(vaultId, itemId);
        return {
          id: item.id,
          title: item.title,
          // Strip field VALUES — this detail view is used for the
          // browse-and-pick UX and must never carry secret material.
          fields: item.fields.map((f) => ({ id: f.id, title: f.title, fieldType: f.fieldType })),
        };
      },
    },
  };
}

// ── Service factory ───────────────────────────────────────────────────────

function tokenOwner(scope: OnePasswordScope, ctx: OnePasswordCtx): CredentialOwner {
  return scope === "org" ? { type: "org", id: ctx.orgId } : { type: "user", id: ctx.userId };
}

/**
 * Wraps any SDK rejection as `OnePasswordAuthError`, prefixed with `context`.
 * Already-typed errors (missing token, disabled toggle, a prior wrap) pass
 * through unchanged — never double-wrapped.
 */
function wrapSdkError(err: unknown, context: string): OnePasswordAuthError {
  if (err instanceof OnePasswordAuthError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new OnePasswordAuthError(`${context}: ${msg}`);
}

export function createOnePasswordService(deps: OnePasswordDeps): OnePasswordService {
  const createClient = deps.createClient ?? defaultCreateClient;
  const now = deps.now ?? Date.now;

  // Keyed by token string so a rotated token evicts the stale client.
  const clientCache = new Map<string, Promise<OpClient>>();
  // Keyed by `${scope}:${ownerId}:${reference}`.
  const resolveCache = new Map<string, { value: string; at: number }>();

  async function requireToken(scope: OnePasswordScope, ctx: OnePasswordCtx): Promise<string> {
    const owner = tokenOwner(scope, ctx);
    const row = await deps.credentials.get(owner, ONEPASSWORD_SERVICE);
    if (!row?.apiKey) {
      const kind = scope === "org" ? "organization" : "personal";
      throw new OnePasswordAuthError(
        `This org has no ${kind} 1Password service account token connected.`,
      );
    }
    return row.apiKey;
  }

  async function clientFor(scope: OnePasswordScope, ctx: OnePasswordCtx): Promise<OpClient> {
    if (scope === "personal") {
      const allowed = await deps.getAllowPersonal(ctx.orgId);
      if (!allowed) {
        throw new OnePasswordAuthError(
          "Personal 1Password tokens are disabled by your organization.",
        );
      }
    }
    const token = await requireToken(scope, ctx);
    let pending = clientCache.get(token);
    if (!pending) {
      pending = createClient(token).catch((err: unknown) => {
        // Evict on rejection — a transient failure (network blip, momentary
        // SDK hiccup) must not permanently poison this token's cache entry
        // until process restart. The next call re-attempts construction.
        clientCache.delete(token);
        throw wrapSdkError(err, "1Password client initialization failed");
      });
      clientCache.set(token, pending);
    }
    return pending;
  }

  async function resolveReference(
    scope: OnePasswordScope,
    ctx: OnePasswordCtx,
    reference: string,
  ): Promise<string> {
    const client = await clientFor(scope, ctx);
    const owner = tokenOwner(scope, ctx);
    const cacheKey = `${scope}:${owner.id}:${reference}`;
    const cached = resolveCache.get(cacheKey);
    const nowMs = now();
    if (cached && nowMs - cached.at < RESOLVE_TTL_MS) {
      return cached.value;
    }
    try {
      const value = await client.secrets.resolve(reference);
      resolveCache.set(cacheKey, { value, at: nowMs });
      return value;
    } catch (err) {
      throw wrapSdkError(err, `1Password resolution failed for ${reference}`);
    }
  }

  async function resolveCredential(
    row: StoredCredential,
    ctx: OnePasswordCtx,
  ): Promise<StoredCredential> {
    const meta = onePasswordMeta(row);
    if (!meta) return row;
    const secret = await resolveReference(meta.tokenScope, ctx, meta.reference);
    const resolved: StoredCredential = { type: row.type, metadata: row.metadata };
    if (row.type === "api_key") {
      resolved.apiKey = secret;
    } else {
      resolved.accessToken = secret;
    }
    return resolved;
  }

  return {
    async tokenConnected(scope, ctx) {
      const owner = tokenOwner(scope, ctx);
      const row = await deps.credentials.get(owner, ONEPASSWORD_SERVICE);
      return Boolean(row?.apiKey);
    },
    async listVaults(scope, ctx) {
      const client = await clientFor(scope, ctx);
      try {
        return await client.vaults.list();
      } catch (err) {
        throw wrapSdkError(err, "1Password vault listing failed");
      }
    },
    async listItems(scope, ctx, vaultId) {
      const client = await clientFor(scope, ctx);
      try {
        return await client.items.list(vaultId);
      } catch (err) {
        throw wrapSdkError(err, "1Password item listing failed");
      }
    },
    async getItem(scope, ctx, vaultId, itemId) {
      const client = await clientFor(scope, ctx);
      try {
        return await client.items.get(vaultId, itemId);
      } catch (err) {
        throw wrapSdkError(err, "1Password item lookup failed");
      }
    },
    resolveReference,
    resolveCredential,
  };
}
