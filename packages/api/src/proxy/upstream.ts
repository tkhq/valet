// packages/api/src/proxy/upstream.ts
import { getEnvApiKey } from "@mariozechner/pi-ai";
import type { CredentialStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { ProviderKind, Upstream } from "./types.js";
import { listLlmProviders, createLlmProvider } from "../services/llm-providers.js";

const DEFAULT_BASE: Record<ProviderKind, string> = {
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
 * provider of that kind, seed one (name `env:{kind}`) with the env key in
 * CredentialStore, so the Settings UI shows a provider and the demo works
 * with zero setup. Idempotent.
 */
export async function ensureEnvProviders(db: AppDb, credentials: CredentialStore, orgId: string): Promise<void> {
  for (const kind of ["anthropic", "openai"] as const) {
    const env = getEnvApiKey(kind);
    if (!env) continue;
    const existing = (await listLlmProviders(db, orgId)).filter((r) => r.kind === kind);
    if (existing.length > 0) continue;
    const row = await createLlmProvider(db, { orgId, kind, name: `env:${kind}` });
    await credentials.save({ type: "org", id: orgId }, `llm:${row.id}`, { type: "api_key", apiKey: env });
  }
}
