/**
 * Hourly cleanup of commit signing keys past their window (agent commit
 * signing design). For every index row with status `active` and `notAfter`
 * in the past: delete the GitHub key with the user's token, set the user
 * row and the index row to `closed`. The Turnkey private key and both rows
 * stay: they are the issuance record.
 *
 * Expiry is the normal end of every key, so this repair is expected in
 * normal operation. A GitHub failure (token gone, permission removed) logs
 * and leaves the row active for the next tick; the Turnkey session API key
 * has its own expiry and needs no help here.
 */
import { pluginStore } from "../services/plugin-store.js";
import { resolveUserApiToken, type GitHubTokenDeps } from "../services/github-tokens.js";
import { githubSigningKeys, type GitHubSigningKeys } from "@valet/plugin-turnkey/github-keys";
import { COLLECTIONS, PLUGIN_NAME, type SigningKeyDoc, type SigningKeyIndexDoc } from "@valet/plugin-turnkey/store";
import type { PluginStore } from "@valet/engine";
import { startSweepTimer } from "../lib/sweep-timer.js";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

export interface SigningKeySweepDeps {
  /** What `resolveUserApiToken` and `pluginStore` need; the production wiring. */
  tokens?: GitHubTokenDeps;
  intervalMs?: number;
  now?: () => number;
  /** Test seam: the GitHub client for a token. */
  github?: (token: string) => GitHubSigningKeys;
  /** Test seam: the plugin store. Defaults to `pluginStore(tokens.db, "turnkey")`. */
  store?: PluginStore;
  /** Test seam: the user's GitHub token. Defaults to `resolveUserApiToken(tokens, ...)`. */
  resolveToken?: (orgId: string, userId: string) => Promise<string | null>;
}

function wire(deps: SigningKeySweepDeps): { store: PluginStore; resolveToken: NonNullable<SigningKeySweepDeps["resolveToken"]> } {
  const tokens = deps.tokens;
  const store = deps.store ?? (tokens ? pluginStore(tokens.db, PLUGIN_NAME) : undefined);
  const resolveToken =
    deps.resolveToken ??
    (tokens
      ? async (orgId: string, userId: string) => (await resolveUserApiToken(tokens, orgId, userId))?.token ?? null
      : undefined);
  if (!store || !resolveToken) {
    throw new Error("signing-key-sweep: pass `tokens`, or both `store` and `resolveToken`");
  }
  return { store, resolveToken };
}

export interface SigningKeySweepResult {
  checked: number;
  closed: number;
  failed: number;
}

export async function sweepSigningKeysOnce(deps: SigningKeySweepDeps): Promise<SigningKeySweepResult> {
  const now = deps.now ?? (() => Date.now());
  const { store, resolveToken } = wire(deps);
  const github = deps.github ?? ((token: string) => githubSigningKeys(token));
  const result: SigningKeySweepResult = { checked: 0, closed: 0, failed: 0 };

  let cursor: string | undefined;
  do {
    const page = await store.global().list<SigningKeyIndexDoc>(COLLECTIONS.signingKeyIndex, {
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    for (const row of page.items) {
      if (row.doc.status !== "active" || row.doc.notAfter > now()) continue;
      result.checked += 1;
      try {
        const token = await resolveToken(row.doc.orgId, row.doc.userId);
        if (!token) {
          throw new Error("the user has no usable GitHub token; the key stays on GitHub until they reconnect");
        }
        await github(token).remove(row.doc.githubKeyId);
        const closedAt = now();
        const userStore = store.user(row.doc.userId);
        const userRow = await userStore.get<SigningKeyDoc>(COLLECTIONS.signingKeys, row.doc.userKey);
        if (userRow) {
          await userStore.put(COLLECTIONS.signingKeys, row.doc.userKey, { ...userRow.doc, status: "closed", closedAt });
        }
        await store.global().put(COLLECTIONS.signingKeyIndex, row.key, { ...row.doc, status: "closed" });
        result.closed += 1;
      } catch (err) {
        result.failed += 1;
        console.error(
          `signing-key-sweep: could not close key ${row.doc.fingerprint} for user ${row.doc.userId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  return result;
}

export interface SigningKeySweepHandle {
  stop(): void;
}

export function startSigningKeySweep(deps: SigningKeySweepDeps): SigningKeySweepHandle {
  return startSweepTimer("signing-key-sweep", deps.intervalMs ?? DEFAULT_INTERVAL_MS, async () => {
    const r = await sweepSigningKeysOnce(deps);
    if (r.checked > 0) console.log(`signing-key-sweep: checked=${r.checked} closed=${r.closed} failed=${r.failed}`);
  });
}
