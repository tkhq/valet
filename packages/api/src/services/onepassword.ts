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
 * Known `OnePasswordAuthError` cases (missing token, personal toggle off)
 * carry a typed hint. SDK/network failures never interpolate `err.message`
 * or the secret reference into that message — the client sees a fixed
 * `"1Password request failed"`; the original is logged server-side only.
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

/**
 * The SDK's full item, as the vault lookup reads it.
 *
 * Separate from `OpItemDetail` on purpose: that shape omits `value` so the
 * item-detail route cannot return a secret, and it must keep omitting it.
 * Only the lookup, which resolves a value by design, sees this one.
 */
export interface SdkItem {
  title: string;
  notes?: string;
  fields: {
    title: string;
    fieldType: string;
    value?: string;
    details?: { type: string; content?: { code?: string } };
  }[];
}

/** Narrow view of @1password/sdk's client — the only shape this module needs. */
export interface OpClient {
  secrets: { resolve(reference: string): Promise<string> };
  vaults: { list(): Promise<OpVault[]> };
  items: {
    list(vaultId: string): Promise<OpItem[]>;
    get(vaultId: string, itemId: string): Promise<OpItemDetail>;
    /**
     * The item WITH its secret material, for the vault lookup alone.
     *
     * `get` above strips field values on purpose: it backs a browse-and-pick
     * UI that must never carry a secret. The lookup's whole job is to resolve
     * one, so it needs a separate door rather than a widened `get` that every
     * caller would inherit.
     */
    getWithSecrets(vaultId: string, itemId: string): Promise<SdkItem>;
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
  /**
   * The secret for `service`, found by name in the vaults the token can read.
   *
   * This is what makes connecting a token enough: an agent asking for a
   * credential Valet has no row for gets the one sitting in 1Password, with
   * no per-service setup. `null` when nothing matches, which reads as "not
   * connected" upstream.
   */
  findCredentialForService(
    scope: OnePasswordScope,
    ctx: OnePasswordCtx,
    service: string,
  ): Promise<string | null>;
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
      getWithSecrets: async (vaultId: string, itemId: string) => {
        const item = await client.items.get(vaultId, itemId);
        return {
          title: item.title,
          notes: item.notes,
          fields: item.fields.map((f) => ({
            title: f.title,
            fieldType: f.fieldType,
            value: f.value,
            details: f.details as SdkItem["fields"][number]["details"],
          })),
        };
      },
    },
  };
}

// ── Service factory ───────────────────────────────────────────────────────

function tokenOwner(scope: OnePasswordScope, ctx: OnePasswordCtx): CredentialOwner {
  return scope === "org" ? { type: "org", id: ctx.orgId } : { type: "user", id: ctx.userId };
}

const SDK_REQUEST_FAILED = "1Password request failed";

/**
 * Wraps any SDK rejection as `OnePasswordAuthError` with a fixed client
 * message. Already-typed errors (missing token, disabled toggle, a prior
 * wrap) pass through unchanged — never double-wrapped. The original
 * rejection and `context` are logged server-side only; neither
 * `err.message` nor a secret reference is interpolated into the
 * client-visible text.
 */
function wrapSdkError(err: unknown, context: string): OnePasswordAuthError {
  if (err instanceof OnePasswordAuthError) return err;
  console.error(`onepassword: ${context}:`, err);
  return new OnePasswordAuthError(SDK_REQUEST_FAILED);
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
        throw wrapSdkError(err, "client initialization failed");
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
      throw wrapSdkError(err, `resolution failed for ${reference}`);
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

  /**
   * service -> reference, or null for "looked and found nothing". Cached on
   * the same TTL as a resolve: a credential miss must not walk every vault on
   * every tool call, and a negative answer is worth caching too, since the
   * common case for an unconnected service is that nothing matches.
   */
  const lookupCache = new Map<string, { secret: string | null; at: number }>();

  /**
   * Whether an item title names a service. Word-boundary and
   * case-insensitive, so "Linear API Key" names `linear` and "Linearity" does
   * not. Narrow on purpose: this picks the secret an agent authenticates
   * with, and a loose match points it at the wrong one.
   */
  function titleNamesService(title: string, service: string): boolean {
    const needle = service.replace(/[-_]/g, "[-_ ]?").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${needle}([^a-z0-9]|$)`, "i").test(title);
  }

  /**
   * The secret an item holds, as a value rather than a reference.
   *
   * Three shapes, in the order they are worth having:
   *
   *  - a field named for a credential, or any concealed one — the common
   *    Login case, and the only one a plain `op://` reference reaches;
   *  - a Totp field, where the useful value is the code the SDK COMPUTES
   *    (`details.content.code`), never the seed in `field.value`. Handing an
   *    integration the seed would give it the power to mint codes forever;
   *  - the note body, for a SecureNote. That is where an API key usually
   *    lives, and such an item carries no fields at all.
   *
   * Returns the value and how it was found, so the caller can say which.
   */
  function itemSecret(item: SdkItem): { value: string; via: string } | null {
    const named = item.fields.find((f) =>
      /^(credential|api[ _-]?key|token|secret|password)$/i.test(f.title),
    );
    const concealed = item.fields.find((f) => f.fieldType === "Concealed");
    const plain = named ?? concealed;
    if (plain?.value) return { value: plain.value, via: `field ${plain.title}` };

    const totp = item.fields.find((f) => f.fieldType === "Totp");
    const code = totp?.details?.type === "Otp" ? totp.details.content?.code : undefined;
    if (code) return { value: code, via: `one-time code from ${totp!.title}` };

    const notes = item.notes?.trim();
    if (notes) return { value: notes, via: "the note body" };

    return null;
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
        throw wrapSdkError(err, "vault listing failed");
      }
    },
    async listItems(scope, ctx, vaultId) {
      const client = await clientFor(scope, ctx);
      try {
        return await client.items.list(vaultId);
      } catch (err) {
        throw wrapSdkError(err, "item listing failed");
      }
    },
    async getItem(scope, ctx, vaultId, itemId) {
      const client = await clientFor(scope, ctx);
      try {
        return await client.items.get(vaultId, itemId);
      } catch (err) {
        throw wrapSdkError(err, "item lookup failed");
      }
    },
    resolveReference,
    resolveCredential,

    async findCredentialForService(scope, ctx, service) {
      const owner = tokenOwner(scope, ctx);
      const cacheKey = `${scope}:${owner.id}:${service}`;
      const cached = lookupCache.get(cacheKey);
      const nowMs = now();
      // A one-time code expires, so the cache holds it only as long as any
      // resolve is held — the same TTL, for the same reason.
      if (cached && nowMs - cached.at < RESOLVE_TTL_MS) return cached.secret;

      // The SDK client directly: these are the same three reads the list
      // routes make, and going through `this` would tie the lookup to how the
      // object is called.
      const client = await clientFor(scope, ctx);
      let found: string | null = null;
      for (const vault of await client.vaults.list()) {
        let items;
        try {
          items = await client.items.list(vault.id);
        } catch {
          // A vault this token cannot read is not an error for a lookup: the
          // secret may well be in the next one.
          continue;
        }
        const item = items.find((i) => titleNamesService(i.title, service));
        if (!item) continue;
        const detail = await client.items.getWithSecrets(vault.id, item.id);
        const secret = itemSecret(detail);
        if (!secret) continue;
        // The VALUE, not a reference: a note body and a computed one-time
        // code have no `op://` address, so a reference cannot express them.
        found = secret.value;
        break;
      }

      lookupCache.set(cacheKey, { secret: found, at: nowMs });
      return found;
    },
  };
}
