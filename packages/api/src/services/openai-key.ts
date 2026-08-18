import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";
import type { AppQueryable } from "../lib/drizzle.js";
import { listLlmProviders } from "./llm-providers.js";

/**
 * Resolve the OpenAI API key for the `"openai"` credential service — the
 * probe `plugin-openai`'s `requiresCredential` gating and its actions both
 * read. Precedence:
 *
 *   1. The org's enabled OpenAI LLM-provider key (`llm:{rowId}`, the same
 *      credential model resolution uses for `openai/*` chat models).
 *   2. A stored `"openai"` credential for the caller's owner scope (plain
 *      store read — byte-identical to the engine's default path).
 *   3. The host's `OPENAI_API_KEY` env var.
 *
 * `null` means "not configured": the plugin catalog hides the openai tools.
 */
export async function resolveOpenAiCredential(
  db: AppQueryable,
  credentials: CredentialStore,
  owner: CredentialOwner,
  orgId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<StoredCredential | null> {
  const rows = await listLlmProviders(db, orgId);
  const row = rows.find((r) => r.kind === "openai" && r.enabled);
  if (row) {
    const stored = await credentials.get({ type: "org", id: orgId }, `llm:${row.id}`);
    const key = stored?.apiKey?.trim();
    if (key) return { type: "api_key", apiKey: key };
  }
  const direct = await credentials.get(owner, "openai");
  if (direct) return direct;
  const envKey = env.OPENAI_API_KEY?.trim();
  return envKey ? { type: "api_key", apiKey: envKey } : null;
}
