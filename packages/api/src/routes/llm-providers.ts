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
import { getEnvApiKey } from "@mariozechner/pi-ai";
import type { CredentialOwner } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { isOrgAdmin, getOrgModelPreferences, setOrgModelPreferences } from "../services/org.js";
import {
  createLlmProvider,
  deleteLlmProvider,
  getLlmProvider,
  isDefaultProviderNamespace,
  isKnownProviderKind,
  isLlmProviderKind,
  listLlmProviders,
  updateLlmProvider,
  LlmProviderSingletonError,
  DEFAULT_PROVIDER_IN_USE_ERROR,
  type LlmProviderKind,
  type UpdateLlmProviderOptions,
} from "../services/llm-providers.js";
import type { LlmProviderModel, LlmProviderRow } from "../schema/index.js";
import type {
  CreateLlmProviderRequest,
  CreateLlmProviderResponse,
  GetLlmProviderPreferencesResponse,
  ListLlmProvidersResponse,
  LlmProviderSummary,
  PatchLlmProviderRequest,
  PatchLlmProviderResponse,
  PutLlmProviderKeyRequest,
  PutLlmProviderKeyResponse,
  PutLlmProviderPreferencesRequest,
  PutLlmProviderPreferencesResponse,
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

function isLlmProviderModelArray(v: unknown): v is LlmProviderModel[] {
  if (!Array.isArray(v)) return false;
  return v.every(
    (m) => typeof m === "object" && m !== null && typeof (m as Record<string, unknown>).id === "string" && typeof (m as Record<string, unknown>).name === "string",
  );
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

  const { db } = c.var.providers;
  const user = c.var.user;

  let body: PutLlmProviderPreferencesRequest;
  try {
    body = (await c.req.json()) as PutLlmProviderPreferencesRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  // Array-of-strings shape only — validating each id against the org
  // catalog (namespace exists, model exists) is Task 4's job once the
  // catalog lands; this route just persists whatever ordered list it's given.
  if (!Array.isArray(body.preferences) || !body.preferences.every((p) => typeof p === "string")) {
    return c.json({ error: "preferences must be an array of strings" }, 400);
  }

  await setOrgModelPreferences(db, user.orgId, body.preferences);
  const resp: PutLlmProviderPreferencesResponse = { preferences: body.preferences };
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
    return c.json({ error: "kind must be one of anthropic|openai|google|openai_compatible" }, 400);
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
  if (body.models !== undefined && body.kind !== "openai_compatible") {
    return c.json({ error: "models is only accepted for openai_compatible providers" }, 400);
  }

  try {
    const row = await createLlmProvider(db, {
      orgId: user.orgId,
      kind: body.kind,
      name: body.name,
      baseUrl: baseUrlCheck.value,
      models: body.kind === "openai_compatible" ? body.models : undefined,
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
    if (existing.kind !== "openai_compatible") {
      return c.json({ error: "models is only accepted for openai_compatible providers" }, 400);
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

export type LlmProvidersRouter = typeof llmProvidersRouter;
