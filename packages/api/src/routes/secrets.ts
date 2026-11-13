/**
 * `/api/secrets` — names of company, team, and personal secrets in the
 * configured secret store, and the sealed save and delete calls.
 *
 * A save has two steps. `import/begin` authorizes the scope and name and
 * returns the provider's envelope. The browser seals the value to it, and
 * `import/finish` sends only the sealed value. The api never holds the
 * plaintext on this path.
 *
 * No route here returns a value. A saved secret is read only by
 * `valet-secrets run`, through `/api/sandbox-secrets/resolve`. A sandbox
 * token never reaches this router: the auth ladder refuses it on every path
 * outside the sandbox prefixes.
 */
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import { SecretStoreError } from "../services/secret-store/provider.js";
import type { SecretActor, SecretScope } from "../services/secret-store/service.js";
import { isOrgAdmin } from "../services/org.js";
import { isTeamMember } from "../services/teams.js";
import type {
  BeginSecretSaveResponse,
  FinishSecretSaveRequest,
  SecretSummary,
  SecretsListResponse,
} from "../wire/types.js";

export const secretsRouter = new Hono<AppEnv>();

const STATUS = {
  disabled: 503,
  not_found: 404,
  exists: 409,
  forbidden: 403,
  provider: 502,
  invalid_name: 400,
  invalid_value: 400,
  too_many: 400,
} as const;

function mapError(c: Context<AppEnv>, err: unknown) {
  if (!(err instanceof SecretStoreError)) throw err;
  return c.json({ error: err.message }, STATUS[err.kind]);
}

/** The scope a request names, or an error that says what to send. */
export function parseScope(kind: unknown, teamId: unknown): SecretScope | string {
  if (kind === undefined || kind === "personal") return { kind: "personal" };
  if (kind === "company") return { kind: "company" };
  if (kind === "team") {
    return typeof teamId === "string" && teamId.length > 0 ? { kind: "team", teamId } : "Pass teamId with scope=team.";
  }
  return "Pass scope as personal, team, or company.";
}

function actorOf(c: Context<AppEnv>): SecretActor {
  return { orgId: c.var.user.orgId, userId: c.var.user.id };
}

async function canWrite(c: Context<AppEnv>, scope: SecretScope): Promise<boolean> {
  const { db } = c.var.providers;
  const actor = actorOf(c);
  if (scope.kind === "personal") return true;
  if (scope.kind === "company") return isOrgAdmin(db, actor.orgId, actor.userId);
  return isTeamMember(db, scope.teamId, actor.userId);
}

secretsRouter.get("/", async (c) => {
  const { secretStore } = c.var.providers;
  const scope = parseScope(c.req.query("scope"), c.req.query("teamId"));
  if (typeof scope === "string") return c.json({ error: scope }, 400);
  if (!secretStore.enabled) {
    const resp: SecretsListResponse = { enabled: false, provider: null, canWrite: false, secrets: [] };
    return c.json(resp);
  }
  try {
    const rows = await secretStore.list(actorOf(c), scope);
    const secrets: SecretSummary[] = rows.map((r) => ({ name: r.name, reference: r.reference, createdAt: r.createdAt }));
    const resp: SecretsListResponse = {
      enabled: true,
      provider: secretStore.providerLabel,
      canWrite: await canWrite(c, scope),
      secrets,
    };
    return c.json(resp);
  } catch (err) {
    return mapError(c, err);
  }
});

async function readBody(c: Context<AppEnv>): Promise<Partial<FinishSecretSaveRequest> | null> {
  try {
    const body: unknown = await c.req.json();
    return typeof body === "object" && body !== null ? (body as Partial<FinishSecretSaveRequest>) : null;
  } catch {
    return null;
  }
}

secretsRouter.post("/import/begin", async (c) => {
  const { secretStore } = c.var.providers;
  const body = await readBody(c);
  if (!body || typeof body.name !== "string") return c.json({ error: "Send a JSON body with scope and name." }, 400);
  const scope = parseScope(body.scope, body.teamId);
  if (typeof scope === "string") return c.json({ error: scope }, 400);
  try {
    const envelope = await secretStore.beginSave(actorOf(c), scope, body.name.trim(), { replace: body.replace === true });
    const resp: BeginSecretSaveResponse = { envelope };
    return c.json(resp);
  } catch (err) {
    return mapError(c, err);
  }
});

secretsRouter.post("/import/finish", async (c) => {
  const { secretStore } = c.var.providers;
  const body = await readBody(c);
  const sealed = body?.sealed;
  if (!body || typeof body.name !== "string" || typeof sealed !== "object" || sealed === null || typeof sealed.kind !== "string") {
    return c.json({ error: "Send a JSON body with scope, name, and the sealed value." }, 400);
  }
  const scope = parseScope(body.scope, body.teamId);
  if (typeof scope === "string") return c.json({ error: scope }, 400);
  try {
    const saved = await secretStore.finishSave(actorOf(c), scope, body.name.trim(), sealed, { replace: body.replace === true });
    const resp: SecretSummary = { name: saved.name, reference: saved.reference, createdAt: saved.createdAt };
    return c.json(resp, 201);
  } catch (err) {
    return mapError(c, err);
  }
});

/** `?name=` rather than a path segment: a name can contain `/`. */
secretsRouter.delete("/", async (c) => {
  const { secretStore } = c.var.providers;
  const name = c.req.query("name");
  if (!name) return c.json({ error: "Pass the secret's name as ?name=." }, 400);
  const scope = parseScope(c.req.query("scope"), c.req.query("teamId"));
  if (typeof scope === "string") return c.json({ error: scope }, 400);
  try {
    await secretStore.remove(actorOf(c), scope, name);
    return c.json({ ok: true });
  } catch (err) {
    return mapError(c, err);
  }
});
