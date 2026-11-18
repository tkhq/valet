/**
 * Hourly close of session-mode signing windows past their end
 * (`docs/specs/2026-11-17-commit-signing-user-registered-keys-design.md`).
 * For every index row with status `active` and a `notAfter` in the past, set
 * the user row and the index row to `closed`. Rows stay: they are the
 * issuance record, and the allowed-signers file keeps listing them.
 *
 * Valet no longer adds keys to GitHub, so there is nothing to remove there.
 * The Turnkey session API key has its own expiry. Window expiry is normal
 * operation, which is why this repair exists. A person's enrollment key has
 * no `notAfter` and is never closed here.
 */
import type { AppQueryable } from "../lib/drizzle.js";
import { pluginStore } from "../services/plugin-store.js";
import { COLLECTIONS, PLUGIN_NAME, type SigningKeyDoc, type SigningKeyIndexDoc } from "@valet/plugin-turnkey/store";
import type { PluginStore } from "@valet/engine";
import { startSweepTimer } from "../lib/sweep-timer.js";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

export interface SigningKeySweepDeps {
  db?: AppQueryable;
  /** Test seam: the plugin store. Defaults to `pluginStore(db, "turnkey")`. */
  store?: PluginStore;
  intervalMs?: number;
  now?: () => number;
}

export interface SigningKeySweepResult {
  checked: number;
  closed: number;
  failed: number;
}

export async function sweepSigningKeysOnce(deps: SigningKeySweepDeps): Promise<SigningKeySweepResult> {
  const now = deps.now ?? (() => Date.now());
  const store = deps.store ?? (deps.db ? pluginStore(deps.db, PLUGIN_NAME) : undefined);
  if (!store) throw new Error("signing-key-sweep: pass `db` or `store`");
  const result: SigningKeySweepResult = { checked: 0, closed: 0, failed: 0 };

  let cursor: string | undefined;
  do {
    const page = await store.global().list<SigningKeyIndexDoc>(COLLECTIONS.signingKeyIndex, {
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    for (const row of page.items) {
      if (row.doc.status !== "active" || row.doc.notAfter === undefined || row.doc.notAfter > now()) continue;
      result.checked += 1;
      try {
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
          `signing-key-sweep: could not close window ${row.key} for user ${row.doc.userId}:`,
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
