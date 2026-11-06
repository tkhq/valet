// packages/api/src/proxy/upstream.ts
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import type { CredentialStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { ProviderKind, Upstream } from "./types.js";
import { listLlmProviders, createLlmProvider } from "../services/llm-providers.js";

export const DEFAULT_BASE: Record<ProviderKind, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

/** Seam for tests: real deps read the db + env; tests inject fakes. */
export interface UpstreamDeps {
  listProviders: (kind: ProviderKind) => Promise<Array<{ id: string; kind: string; baseUrl: string | null }>>;
  envKey: (kind: ProviderKind) => string | undefined;
}

function defaultDeps(db: AppDb, orgId: string): UpstreamDeps {
  return {
    listProviders: async (kind) =>
      (await listLlmProviders(db, orgId)).filter((r) => r.kind === kind && r.enabled),
    envKey: (kind) => getEnvApiKey(kind),
  };
}

/**
 * Resolves the real upstream for a provider kind: the org's first enabled
 * provider row of that kind (key from CredentialStore `llm:{id}`), else the
 * process env key (dev). Returns null when neither exists — the caller then
 * returns a wire-correct 502 naming the fix.
 */
export async function resolveUpstream(
  db: AppDb,
  credentials: CredentialStore,
  orgId: string,
  kind: ProviderKind,
  deps: UpstreamDeps = defaultDeps(db, orgId),
): Promise<Upstream | null> {
  const rows = await deps.listProviders(kind);
  const owner = { type: "org" as const, id: orgId };
  for (const row of rows) {
    const stored = await credentials.get(owner, `llm:${row.id}`);
    if (stored?.apiKey) return { baseUrl: row.baseUrl || DEFAULT_BASE[kind], apiKey: stored.apiKey };
  }
  const env = deps.envKey(kind);
  return env ? { baseUrl: DEFAULT_BASE[kind], apiKey: env } : null;
}

/**
 * Boot step: for each kind, if the env key is set and the org has no
 * provider of that kind, seed one (name `env:{kind}`) so the Settings UI shows
 * a provider and the demo works with zero setup. Idempotent.
 *
 * An `env:` provider stores no key: every key reader falls back to the env
 * key when `llm:{id}` is empty, so rotating the env var and restarting the
 * api changes the key Valet uses (TKAI-710). Earlier builds stored a copy of
 * the env key here; that copy outlived every rotation, so this step deletes
 * it. A key an admin saved in Settings carries `metadata.last4` and stays.
 */
export async function ensureEnvProviders(db: AppDb, credentials: CredentialStore, orgId: string): Promise<void> {
  const owner = { type: "org" as const, id: orgId };
  for (const kind of ["anthropic", "openai"] as const) {
    const existing = (await listLlmProviders(db, orgId)).filter((r) => r.kind === kind);
    for (const row of existing) {
      if (row.name !== `env:${kind}`) continue;
      const stored = await credentials.get(owner, `llm:${row.id}`);
      if (stored && stored.metadata?.last4 === undefined) await credentials.delete(owner, `llm:${row.id}`);
    }
    if (existing.length > 0 || !getEnvApiKey(kind)) continue;
    await createLlmProvider(db, { orgId, kind, name: `env:${kind}` });
  }
}
