/**
 * `/api/secrets` — the signed-in user's own personal secrets in the
 * configured secret store: list names, save one, delete one.
 *
 * No route here returns a value. A saved secret is read only by
 * `valet-secrets run` in a session the user owns, through
 * `/api/sandbox-secrets/resolve`. A sandbox token never reaches this router:
 * the auth ladder refuses it on every path outside the sandbox prefixes.
 */
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import { SecretStoreError, type SecretMeta } from "../services/secret-store/provider.js";
import { personalReference } from "../services/secret-store/service.js";
import type { SecretsListResponse, SecretSummary } from "../wire/types.js";

export const secretsRouter = new Hono<AppEnv>();

function summary(meta: SecretMeta): SecretSummary {
  return { name: meta.name, reference: personalReference(meta.name), createdAt: meta.createdAt };
}

const STATUS = {
  disabled: 503,
  not_found: 404,
  exists: 409,
  provider: 502,
  invalid_name: 400,
  invalid_value: 400,
  too_many: 400,
} as const;

function mapError(c: Context<AppEnv>, err: unknown) {
  if (!(err instanceof SecretStoreError)) throw err;
  return c.json({ error: err.message }, STATUS[err.kind]);
}

secretsRouter.get("/", async (c) => {
  const { secretStore } = c.var.providers;
  const user = c.var.user;
  if (!secretStore.enabled) {
    const resp: SecretsListResponse = { enabled: false, provider: null, secrets: [] };
    return c.json(resp);
  }
  try {
    const secrets = await secretStore.list({ orgId: user.orgId, userId: user.id });
    const resp: SecretsListResponse = { enabled: true, provider: secretStore.providerLabel, secrets: secrets.map(summary) };
    return c.json(resp);
  } catch (err) {
    return mapError(c, err);
  }
});

secretsRouter.post("/", async (c) => {
  const { secretStore } = c.var.providers;
  const user = c.var.user;
  let body: { name?: unknown; value?: unknown };
  try {
    body = (await c.req.json()) as { name?: unknown; value?: unknown };
  } catch {
    return c.json({ error: "Send a JSON body with name and value." }, 400);
  }
  if (typeof body.name !== "string" || typeof body.value !== "string") {
    return c.json({ error: "Send name and value as strings." }, 400);
  }
  try {
    const saved = await secretStore.save({ orgId: user.orgId, userId: user.id }, body.name.trim(), body.value);
    return c.json(summary(saved), 201);
  } catch (err) {
    return mapError(c, err);
  }
});

/** `?name=` rather than a path segment: a name can contain `/`. */
secretsRouter.delete("/", async (c) => {
  const { secretStore } = c.var.providers;
  const user = c.var.user;
  const name = c.req.query("name");
  if (!name) return c.json({ error: "Pass the secret's name as ?name=." }, 400);
  try {
    await secretStore.remove({ orgId: user.orgId, userId: user.id }, name);
    return c.json({ ok: true });
  } catch (err) {
    return mapError(c, err);
  }
});
