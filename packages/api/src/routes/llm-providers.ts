/**
 * `/api/org/llm-providers` — org-admin provider CRUD + encrypted key
 * management (llm-providers design doc, plan Task 3). Same
 * DB-backed `requireOrgAdmin` gate as `routes/org.ts`/`routes/org-invites.ts`
 * (not the JWT-role variant `routes/credentials.ts` uses) — every route
 * below 403s `{ error: "org admin required" }` for non-admins.
 *
 * Provider rows are always scoped to the caller's own org
 * (`orgId = user.orgId`); a row belonging to another org 404s exactly like
 * a nonexistent id — this route never leaks cross-org existence via a 403.
 *
 * Keys live in `c.var.providers.engineCredentials` (`CredentialStore`),
 * owner `{ type: "org", id: user.orgId }`, service `llm:{providerRowId}` —
 * never in the `llm_providers` row itself. No response from this router
 * ever contains submitted key material; `PUT .../key` echoes only
 * `keyLast4`, computed from the request body before it's discarded.
 *
 * `GET /preferences` and `PUT /preferences` are registered before the
 * `/:id` routes so `"preferences"` isn't captured as a provider id.
 */
import { Hono, type Context } from "hono";
import { completeSimple, getEnvApiKey } from "@mariozechner/pi-ai";
import type { CredentialOwner } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { isOrgAdmin, getOrgModelPreferences, setOrgModelPreferences } from "../services/org.js";
import { buildOrgCatalog, catalogValidIds } from "../services/model-catalog.js";
import {
  createLlmProvider,
  deleteLlmProvider,
  getLlmProvider,
  isDefaultProviderNamespace,
  isKnownProviderKind,
  isLlmProviderKind,
  listLlmProviders,
  providerNamespace,
  updateLlmProvider,
  LlmProviderSingletonError,
  DEFAULT_PROVIDER_IN_USE_ERROR,
  type LlmProviderKind,
  type UpdateLlmProviderOptions,
} from "../services/llm-providers.js";
import { resolveModelSpec } from "../services/model-resolution.js";
import { curatedOpenrouterModels, mergedOpenrouterModels } from "../services/openrouter.js";
import type { LlmProviderModel, LlmProviderRow } from "../schema/index.js";
import type {
  CreateLlmProviderRequest,
  CreateLlmProviderResponse,
  GetLlmProviderPreferencesResponse,
  ListLlmProvidersResponse,
  LlmProviderSummary,
  OpenrouterRegistryResponse,
  PatchLlmProviderRequest,
  PatchLlmProviderResponse,
  ProbeLlmProviderResponse,
  PutLlmProviderKeyRequest,
  PutLlmProviderKeyResponse,
  PutLlmProviderPreferencesRequest,
  PutLlmProviderPreferencesResponse,
  TestLlmProviderRequest,
  TestLlmProviderResponse,
} from "../wire/types.js";

export const llmProvidersRouter = new Hono<AppEnv>();

const PROVIDER_NOT_FOUND = { error: "provider not found" } as const;

/** Org-admin gate applied to every route below — same pattern as `routes/org.ts`. */
async function requireOrgAdmin(c: Context<AppEnv>) {
  const { db } = c.var.providers;
  const user = c.var.user;
  if (!(await isOrgAdmin(db, user.orgId, user.id))) {
    return c.json({ error: "org admin required" }, 403);
  }
  return undefined;
}

/** A single custom-provider model entry, validated field-by-field. `id`/`name`
 * are required strings; `contextWindow` and `pricing.{input,output}` are
 * optional but MUST be numbers when present — they feed `Model.contextWindow`
 * (compaction thresholds) and `Model.cost` directly, with no further
 * validation downstream, so a non-numeric value here would silently corrupt
 * turn-time model construction rather than fail loudly at config time. */
function isValidLlmProviderModel(m: unknown): m is LlmProviderModel {
  if (typeof m !== "object" || m === null) return false;
  const rec = m as Record<string, unknown>;
  if (typeof rec.id !== "string" || typeof rec.name !== "string") return false;
  if (rec.contextWindow !== undefined && typeof rec.contextWindow !== "number") return false;
  if (rec.pricing !== undefined) {
    if (typeof rec.pricing !== "object" || rec.pricing === null) return false;
    const pricing = rec.pricing as Record<string, unknown>;
    if (typeof pricing.input !== "number" || typeof pricing.output !== "number") return false;
  }
  return true;
}

function isLlmProviderModelArray(v: unknown): v is LlmProviderModel[] {
  if (!Array.isArray(v)) return false;
  return v.every(isValidLlmProviderModel);
}

/** Kinds whose rows carry a `models` list: custom providers (their full
 * declared list) and openrouter (the curated selection from pi-ai's
 * registry — see `services/openrouter.ts`). */
function kindAcceptsModels(kind: LlmProviderKind): boolean {
  return kind === "openai_compatible" || kind === "openrouter";
}

/** `baseUrl` is required for `openai_compatible` and refused for known kinds. */
function validateBaseUrl(kind: LlmProviderKind, baseUrl: unknown): { error: string } | { value: string | undefined } {
  if (kind === "openai_compatible") {
    if (typeof baseUrl !== "string" || baseUrl.length === 0) {
      return { error: "baseUrl is required for openai_compatible providers" };
    }
    return { value: baseUrl };
  }
  if (baseUrl !== undefined) {
    return { error: "baseUrl is not allowed for known provider kinds" };
  }
  return { value: undefined };
}

async function toSummary(c: Context<AppEnv>, row: LlmProviderRow): Promise<LlmProviderSummary> {
  const { engineCredentials } = c.var.providers;
  const owner: CredentialOwner = { type: "org", id: row.orgId };
  const stored = await engineCredentials.get(owner, `llm:${row.id}`);
  const hasKey = stored !== null;
  const last4 = typeof stored?.metadata?.last4 === "string" ? stored.metadata.last4 : undefined;
  const envFallback = !hasKey && isKnownProviderKind(row.kind) && Boolean(getEnvApiKey(row.kind));

  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    baseUrl: row.baseUrl ?? undefined,
    enabled: row.enabled,
    models: row.models,
    hasKey,
    keyLast4: last4,
    envFallback,
    createdAt: row.createdAt,
  };
}

// ── GET /preferences, PUT /preferences — registered BEFORE /:id ─────────

llmProvidersRouter.get("/preferences", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { db } = c.var.providers;
  const user = c.var.user;
  const preferences = await getOrgModelPreferences(db, user.orgId);
  const resp: GetLlmProviderPreferencesResponse = { preferences };
  return c.json(resp);
});

llmProvidersRouter.put("/preferences", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { db, engineCredentials } = c.var.providers;
  const user = c.var.user;

  let body: PutLlmProviderPreferencesRequest;
  try {
    body = (await c.req.json()) as PutLlmProviderPreferencesRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (!Array.isArray(body.preferences) || !body.preferences.every((p) => typeof p === "string")) {
    return c.json({ error: "preferences must be an array of strings" }, 400);
  }

  // Each id must be active in the org catalog — bare ids remain valid
  // back-compat for Anthropic (services/model-catalog.ts's catalogValidIds).
  const entries = await buildOrgCatalog(db, engineCredentials, user.orgId);
  const validIds = catalogValidIds(entries);
  const unknownIds = body.preferences.filter((id) => !validIds.has(id));
  if (unknownIds.length > 0) {
    return c.json({ error: `unknown or inactive model id(s): ${unknownIds.join(", ")}` }, 400);
  }

  await setOrgModelPreferences(db, user.orgId, body.preferences);
  const resp: PutLlmProviderPreferencesResponse = { preferences: body.preferences };
  return c.json(resp);
});

// ── GET /openrouter/models — live OpenRouter catalog ∪ pi-ai registry ────
//
// Powers the settings model-selection picker for openrouter rows. Like
// `/preferences`, registered before `/:id` so "openrouter" is never
// captured as a provider id. Attempts OpenRouter's live `/api/v1/models`
// (so brand-new models are pickable before any pi-ai registry bump) and
// merges with the built-in registry; degrades to registry-only offline
// (`live: false`).

llmProvidersRouter.get("/openrouter/models", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { models, live } = await mergedOpenrouterModels();
  const resp: OpenrouterRegistryResponse = { models, live };
  return c.json(resp);
});

// ── GET / — list ──────────────────────────────────────────────────────────

llmProvidersRouter.get("/", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { db } = c.var.providers;
  const user = c.var.user;
  const rows = await listLlmProviders(db, user.orgId);
  const providers = await Promise.all(rows.map((row) => toSummary(c, row)));
  const resp: ListLlmProvidersResponse = { providers };
  return c.json(resp);
});

// ── POST / — create ──────────────────────────────────────────────────────

llmProvidersRouter.post("/", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { db } = c.var.providers;
  const user = c.var.user;

  let body: CreateLlmProviderRequest;
  try {
    body = (await c.req.json()) as CreateLlmProviderRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (!isLlmProviderKind(body.kind)) {
    return c.json({ error: "kind must be one of anthropic|openai|google|openrouter|openai_compatible" }, 400);
  }
  if (typeof body.name !== "string" || body.name.length === 0) {
    return c.json({ error: "name is required" }, 400);
  }
  const baseUrlCheck = validateBaseUrl(body.kind, body.baseUrl);
  if ("error" in baseUrlCheck) {
    return c.json({ error: baseUrlCheck.error }, 400);
  }
  if (body.models !== undefined && !isLlmProviderModelArray(body.models)) {
    return c.json({ error: "models must be an array of {id, name}" }, 400);
  }
  if (body.models !== undefined && !kindAcceptsModels(body.kind)) {
    return c.json({ error: "models is only accepted for openai_compatible or openrouter providers" }, 400);
  }

  try {
    const row = await createLlmProvider(db, {
      orgId: user.orgId,
      kind: body.kind,
      name: body.name,
      baseUrl: baseUrlCheck.value,
      // OpenRouter rows seed the curated default selection unless the
      // caller supplied an explicit list (services/openrouter.ts).
      models: kindAcceptsModels(body.kind)
        ? body.models ?? (body.kind === "openrouter" ? curatedOpenrouterModels() : undefined)
        : undefined,
    });
    const resp: CreateLlmProviderResponse = await toSummary(c, row);
    return c.json(resp, 201);
  } catch (err) {
    if (err instanceof LlmProviderSingletonError) {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }
});

// ── PATCH /:id — update ──────────────────────────────────────────────────

llmProvidersRouter.patch("/:id", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { db } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const existing = await getLlmProvider(db, user.orgId, id);
  if (!existing) return c.json(PROVIDER_NOT_FOUND, 404);

  let body: PatchLlmProviderRequest;
  try {
    body = (await c.req.json()) as PatchLlmProviderRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const patch: UpdateLlmProviderOptions = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.length === 0) {
      return c.json({ error: "name must be a non-empty string" }, 400);
    }
    patch.name = body.name;
  }
  if (body.baseUrl !== undefined) {
    const baseUrlCheck = validateBaseUrl(existing.kind, body.baseUrl);
    if ("error" in baseUrlCheck) {
      return c.json({ error: baseUrlCheck.error }, 400);
    }
    patch.baseUrl = baseUrlCheck.value ?? null;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled must be a boolean" }, 400);
    }
    patch.enabled = body.enabled;
  }
  if (body.models !== undefined) {
    if (!isLlmProviderModelArray(body.models)) {
      return c.json({ error: "models must be an array of {id, name}" }, 400);
    }
    if (!kindAcceptsModels(existing.kind)) {
      return c.json({ error: "models is only accepted for openai_compatible or openrouter providers" }, 400);
    }
    patch.models = body.models;
  }

  const updated = await updateLlmProvider(db, user.orgId, id, patch);
  if (!updated) return c.json(PROVIDER_NOT_FOUND, 404);
  const resp: PatchLlmProviderResponse = await toSummary(c, updated);
  return c.json(resp);
});

// ── PUT /:id/key, DELETE /:id/key — key management ──────────────────────

llmProvidersRouter.put("/:id/key", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { db, engineCredentials } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const existing = await getLlmProvider(db, user.orgId, id);
  if (!existing) return c.json(PROVIDER_NOT_FOUND, 404);

  let body: PutLlmProviderKeyRequest;
  try {
    body = (await c.req.json()) as PutLlmProviderKeyRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.apiKey !== "string" || body.apiKey.length === 0) {
    return c.json({ error: "apiKey is required" }, 400);
  }

  const last4 = body.apiKey.slice(-4);
  const owner: CredentialOwner = { type: "org", id: user.orgId };
  await engineCredentials.save(owner, `llm:${id}`, {
    type: "api_key",
    apiKey: body.apiKey,
    metadata: { last4 },
  });

  const resp: PutLlmProviderKeyResponse = { hasKey: true, keyLast4: last4 };
  return c.json(resp);
});

llmProvidersRouter.delete("/:id/key", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { db, engineCredentials } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const existing = await getLlmProvider(db, user.orgId, id);
  if (!existing) return c.json(PROVIDER_NOT_FOUND, 404);

  // Custom (openai_compatible) providers have NO env fallback — deleting the
  // key backing `orgPreferences[0]` leaves new sessions with nothing to fall
  // back to until the array is rewritten (same failure `EngineHost.
  // orgPreferredModel`'s active-provider walk now guards against on the
  // read side). Known kinds are exempt: they may still resolve via an env
  // var, and even when no env var is configured that's a deployment-time
  // fact the read-side fall-through already covers, not something this
  // write-time guard needs to duplicate.
  if (existing.kind === "openai_compatible") {
    const preferences = await getOrgModelPreferences(db, user.orgId);
    if (isDefaultProviderNamespace(existing, preferences)) {
      return c.json({ error: DEFAULT_PROVIDER_IN_USE_ERROR }, 409);
    }
  }

  const owner: CredentialOwner = { type: "org", id: user.orgId };
  await engineCredentials.delete(owner, `llm:${id}`);

  return c.body(null, 204);
});

// ── DELETE /:id — delete provider ────────────────────────────────────────

llmProvidersRouter.delete("/:id", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { db, engineCredentials } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const existing = await getLlmProvider(db, user.orgId, id);
  if (!existing) return c.json(PROVIDER_NOT_FOUND, 404);

  const preferences = await getOrgModelPreferences(db, user.orgId);
  if (isDefaultProviderNamespace(existing, preferences)) {
    return c.json({ error: DEFAULT_PROVIDER_IN_USE_ERROR }, 409);
  }

  const owner: CredentialOwner = { type: "org", id: user.orgId };
  await engineCredentials.delete(owner, `llm:${id}`);
  await deleteLlmProvider(db, user.orgId, id);

  return c.body(null, 204);
});

// ── POST /:id/probe — custom-provider model discovery ───────────────────

/** Replaces every occurrence of `secret` in `text` — a defense-in-depth
 * backstop for a pathological upstream that echoes the `Authorization`
 * header (or a redirect target embedding it) back in an error body. This
 * route already never sends the key anywhere but the upstream `/models`
 * call, so this only guards against the upstream itself leaking it back. */
function redact(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join("[REDACTED]");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

llmProvidersRouter.post("/:id/probe", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { db, engineCredentials } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const existing = await getLlmProvider(db, user.orgId, id);
  if (!existing) return c.json(PROVIDER_NOT_FOUND, 404);
  if (existing.kind !== "openai_compatible") {
    return c.json({ error: "probe is only available for custom (openai_compatible) providers" }, 400);
  }
  if (!existing.baseUrl) {
    return c.json({ error: "provider has no baseUrl configured" }, 400);
  }

  const owner: CredentialOwner = { type: "org", id: user.orgId };
  const stored = await engineCredentials.get(owner, `llm:${existing.id}`);
  const apiKey = stored?.apiKey;
  if (!apiKey) {
    return c.json({ error: "provider has no API key" }, 400);
  }

  // `baseUrl` is admin-supplied and treated as trusted (same trust model as
  // the turn-time resolution path in services/model-resolution.ts). Bearer
  // stripping on cross-origin redirects is the fetch/undici runtime's
  // spec-mandated behavior; we do not re-implement it here. Strip a trailing
  // slash before joining so `https://x/v1` and `https://x/v1/` both probe
  // `https://x/v1/models`, not `https://x/v1//models`.
  const probeBaseUrl = existing.baseUrl.replace(/\/+$/, "");
  let upstream: Response;
  try {
    upstream = await fetch(`${probeBaseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: redact(message, apiKey) }, 502);
  }

  if (!upstream.ok) {
    const bodyText = await upstream.text();
    return c.json({ error: redact(`${upstream.status} ${upstream.statusText}: ${bodyText}`, apiKey) }, 502);
  }

  let parsed: unknown;
  try {
    parsed = await upstream.json();
  } catch {
    return c.json({ error: "malformed /models response from provider (invalid JSON)" }, 502);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
    return c.json({ error: "malformed /models response from provider (expected { data: [...] })" }, 502);
  }
  const models = parsed.data
    .filter((m): m is { id: string } => isRecord(m) && typeof m.id === "string")
    .map((m) => ({ id: m.id }));

  const resp: ProbeLlmProviderResponse = { models };
  return c.json(resp);
});

// ── POST /:id/test — provider test button (1-token completion) ──────────

llmProvidersRouter.post("/:id/test", async (c) => {
  const forbidden = await requireOrgAdmin(c);
  if (forbidden) return forbidden;

  const { db, engineCredentials } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  let body: TestLlmProviderRequest;
  try {
    body = (await c.req.json()) as TestLlmProviderRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.modelId !== "string" || body.modelId.length === 0) {
    return c.json({ error: "modelId is required" }, 400);
  }

  const existing = await getLlmProvider(db, user.orgId, id);
  if (!existing) return c.json(PROVIDER_NOT_FOUND, 404);

  const spec = `${providerNamespace(existing)}/${body.modelId}`;

  let apiKey: string | undefined;
  try {
    const resolved = await resolveModelSpec(db, engineCredentials, user.orgId, spec);
    if (!resolved) {
      const resp: TestLlmProviderResponse = { ok: false, error: `model ${body.modelId} not found` };
      return c.json(resp);
    }
    apiKey = resolved.apiKey;

    const start = Date.now();
    const result = await completeSimple(
      resolved.model,
      {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
      },
      { apiKey, maxTokens: 1 },
    );
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      const resp: TestLlmProviderResponse = {
        ok: false,
        error: redact(result.errorMessage ?? `completion failed (stopReason: ${result.stopReason})`, apiKey),
      };
      return c.json(resp);
    }
    const resp: TestLlmProviderResponse = { ok: true, latencyMs: Date.now() - start };
    return c.json(resp);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const resp: TestLlmProviderResponse = { ok: false, error: redact(message, apiKey) };
    return c.json(resp);
  }
});
