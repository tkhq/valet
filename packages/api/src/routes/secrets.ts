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
import { normalizeUseRule, useOwner, type SecretActor, type SecretScope, type UseRule } from "../services/secret-store/service.js";
import { isOrgAdmin } from "../services/org.js";
import { forgetSecretUses, secretUseStats } from "../services/secret-use-log.js";
import { isTeamMember } from "../services/teams.js";
import type {
  BeginSecretSaveResponse,
  FinishSecretSaveRequest,
  SecretSealEnvelope,
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
    const resp: SecretsListResponse = { enabled: false, provider: null, canWrite: false, useAvailable: false, secrets: [] };
    return c.json(resp);
  }
  try {
    const actor = actorOf(c);
    const rows = await secretStore.list(actor, scope);
    const useNames = rows.filter((r) => r.use).map((r) => r.name);
    const stats = await secretUseStats(c.var.providers.db, actor.orgId, useOwner(actor.orgId, actor.userId, scope), useNames);
    const secrets: SecretSummary[] = rows.map((r) => ({
      name: r.name,
      reference: r.reference,
      createdAt: r.createdAt,
      ...(r.use ? { use: r.use, uses: stats.get(r.name) ?? { count: 0, lastUsedAt: null } } : {}),
    }));
    const resp: SecretsListResponse = {
      enabled: true,
      provider: secretStore.providerLabel,
      canWrite: await canWrite(c, scope),
      useAvailable: c.var.providers.secretUse !== null,
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

/** The use rule a save asks for, or undefined for an ordinary secret. Throws
 * a `SecretStoreError` when the rule is malformed or no use service is set. */
function useRuleOf(c: Context<AppEnv>, body: Partial<FinishSecretSaveRequest>): UseRule | undefined {
  if (body.use === undefined) return undefined;
  if (!c.var.providers.secretUse) {
    throw new SecretStoreError("This Valet has no secret use service, so a secret cannot be saved for one host. Save it without a host.", "invalid_value");
  }
  if (typeof body.use !== "object" || body.use === null) throw new SecretStoreError("Send use as an object with hosts and header.", "invalid_value");
  return normalizeUseRule(body.use);
}

secretsRouter.post("/import/begin", async (c) => {
  const { secretStore } = c.var.providers;
  const body = await readBody(c);
  if (!body || typeof body.name !== "string") return c.json({ error: "Send a JSON body with scope and name." }, 400);
  const scope = parseScope(body.scope, body.teamId);
  if (typeof scope === "string") return c.json({ error: scope }, 400);
  try {
    const use = useRuleOf(c, body);
    const actor = actorOf(c);
    const envelope: SecretSealEnvelope = await secretStore.beginSave(actor, scope, body.name.trim(), { replace: body.replace === true });
    const secretUse = c.var.providers.secretUse;
    const resp: BeginSecretSaveResponse = {
      envelope:
        use && secretUse
          ? { ...envelope, use: { client: secretUse.clientPublicKey, owner: useOwner(actor.orgId, actor.userId, scope), rules: use } }
          : envelope,
    };
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
    const use = useRuleOf(c, body);
    const saved = await secretStore.finishSave(actorOf(c), scope, body.name.trim(), sealed, {
      replace: body.replace === true,
      ...(use ? { use } : {}),
    });
    const resp: SecretSummary = {
      name: saved.name,
      reference: saved.reference,
      createdAt: saved.createdAt,
      ...(saved.use ? { use: saved.use } : {}),
    };
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
    const actor = actorOf(c);
    await secretStore.remove(actor, scope, name);
    await forgetSecretUses(c.var.providers.db, actor.orgId, useOwner(actor.orgId, actor.userId, scope), name);
    return c.json({ ok: true });
  } catch (err) {
    return mapError(c, err);
  }
});
