/**
 * `POST /api/sandbox/env` — Valet-in-Valet sandbox env-var minting.
 *
 * A sandbox running the Valet dev stack (api + web + tests + `make e2e`)
 * needs `ANTHROPIC_API_KEY` on PATH the same way a developer's laptop needs
 * it — the api boots with it, the smoke suites gate on it, and `make e2e`
 * loads it from `.env.e2e`. Baking a key into `.valet/prebuild.yaml` or the
 * sandbox image would commit a secret to the repo and to every OCI layer.
 * Instead the sandbox fetches the key from this route at attach time and
 * writes it to a tmpfs file the shell sources — same pattern as the git
 * credential helper (`routes/sandbox-git-credential.ts`).
 *
 * ── Auth ────────────────────────────────────────────────────────────────
 * Sandbox-token only, exactly as the git credential surface. Mounted at
 * `/api/sandbox/*` so the sandbox rung of `middleware/auth.ts` verifies
 * `x-valet-sandbox` and populates `c.var.sandbox` before this handler
 * runs. A missing or bad token 401s at the middleware.
 *
 * ── Resolution ──────────────────────────────────────────────────────────
 * The route resolves `ANTHROPIC_API_KEY` from the org's LLM-provider
 * credential — the SAME source `services/model-resolution.ts` reads for
 * live model turns — and falls back to `process.env.ANTHROPIC_API_KEY` (the
 * env the api itself booted with) when no org credential is set. The key
 * is emitted ONLY in the response body; it is never logged.
 *
 * Returns `{ apiKey: string }` on success. When no key exists ANYWHERE the
 * response is `{ apiKey: null }` with status 200 — a Valet sandbox that
 * genuinely has no key must still boot; the shim writes an empty value and
 * the api process inside the sandbox surfaces the same "ANTHROPIC_API_KEY
 * is required" message a laptop developer sees.
 *
 * A future extension can widen the surface to a full `{ name, value }[]`
 * bag of env pairs. This pass ships one variable so the smallest useful
 * seam lands first.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { listLlmProviders } from "../services/llm-providers.js";
import type { CredentialStore } from "@valet/engine";
import type { AppQueryable } from "../lib/drizzle.js";
import type { PostSandboxEnvResponse } from "../wire/types.js";

/**
 * Reads the org's `anthropic` LLM-provider row credential, if any. Returns
 * `undefined` when the org has no `anthropic` row or the row has no key.
 * The lookup mirrors `services/model-resolution.ts`'s `orgKey` seam — same
 * `llm:{rowId}` credential kind — so an org key configured for live model
 * turns is the same key handed to a Valet-in-Valet sandbox.
 */
async function orgAnthropicKey(
  db: AppQueryable,
  credentials: CredentialStore,
  orgId: string,
): Promise<string | undefined> {
  const rows = await listLlmProviders(db, orgId);
  const row = rows.find((r) => r.kind === "anthropic");
  if (!row) return undefined;
  const stored = await credentials.get({ type: "org", id: orgId }, `llm:${row.id}`);
  const key = stored?.apiKey;
  return key !== undefined && key.trim() !== "" ? key : undefined;
}

export const sandboxEnvRouter = new Hono<AppEnv>();

sandboxEnvRouter.post("/env", async (c) => {
  const sandbox = c.var.sandbox;
  if (!sandbox) {
    return c.json({ error: "sandbox principal required" }, 401);
  }
  const { db, engineCredentials } = c.var.providers;
  const orgKey = await orgAnthropicKey(db, engineCredentials, sandbox.orgId);
  const envKey = process.env.ANTHROPIC_API_KEY;
  const resolved = orgKey ?? (envKey !== undefined && envKey.trim() !== "" ? envKey : undefined);
  const body: PostSandboxEnvResponse = { anthropicApiKey: resolved ?? null };
  return c.json(body);
});
