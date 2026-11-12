/**
 * Valet secrets: company, team, and personal values read in sessions with
 * `valet-secrets run --env NAME=secret://<scope>/<name>`.
 *
 * This file holds the rules that do not depend on the backend: the reference
 * grammar, name and value limits, who may read and write each scope, one
 * personal space per user, the labels a provider stores with each secret,
 * and the read context it checks. The backend is a `SecretStoreProvider`
 * (`./provider.ts`).
 *
 * | Scope    | Reference                        | Read in                                   | Write          |
 * |----------|----------------------------------|-------------------------------------------|----------------|
 * | company  | `secret://company/NAME`          | any session in the organization           | org admins     |
 * | team     | `secret://team/<teamId>/NAME`    | the team's sessions, a member's own       | team members   |
 * | personal | `secret://personal/NAME`         | a session the owner owns personally       | the owner      |
 *
 * Any organization member can list names. No route returns a value.
 * `/api/sandbox-secrets/resolve` is the one reader and passes the session
 * principal to `read`.
 */
import { and, eq, sql } from "drizzle-orm";
import type { AppDb, AppQueryable } from "../../lib/drizzle.js";
import { secretStoreSpaces } from "../../schema/index.js";
import { isOrgAdmin } from "../org.js";
import { getTeamInOrg, isTeamMember } from "../teams.js";
import {
  SecretStoreError,
  type SealEnvelope,
  type SealedValue,
  type SecretLabels,
  type SecretMeta,
  type SecretStoreProvider,
} from "./provider.js";

export const SECRET_REFERENCE_PREFIX = "secret://";

/** Segments of letters, digits, dot, dash, and underscore, joined by `/`.
 * `granola/api-key` and `GITHUB_TOKEN` are both names. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const TEAM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MAX_SECRET_NAME_LENGTH = 100;
/** A development credential larger than this is a file. */
export const MAX_SECRET_VALUE_BYTES = 16 * 1024;

export type SecretScope = { kind: "personal" } | { kind: "company" } | { kind: "team"; teamId: string };

export function isSecretReference(reference: string): boolean {
  return reference.startsWith(SECRET_REFERENCE_PREFIX);
}

export function validSecretName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_SECRET_NAME_LENGTH && NAME_RE.test(name);
}

/** The scope and name a reference names, or null for any other shape. */
export function parseSecretReference(reference: string): { scope: SecretScope; name: string } | null {
  if (!reference.startsWith(SECRET_REFERENCE_PREFIX)) return null;
  const rest = reference.slice(SECRET_REFERENCE_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 1) return null;
  const kind = rest.slice(0, slash);
  const tail = rest.slice(slash + 1);
  if (kind === "personal" || kind === "company") {
    return validSecretName(tail) ? { scope: { kind }, name: tail } : null;
  }
  if (kind === "team") {
    const next = tail.indexOf("/");
    if (next < 1) return null;
    const teamId = tail.slice(0, next);
    const name = tail.slice(next + 1);
    return TEAM_ID_RE.test(teamId) && validSecretName(name) ? { scope: { kind: "team", teamId }, name } : null;
  }
  return null;
}

/** The reference path after `secret://`. */
function referencePrefix(scope: SecretScope): string {
  return scope.kind === "team" ? `team/${scope.teamId}/` : `${scope.kind}/`;
}

/** The name prefix inside a space. Company secrets carry the org id, because
 * every org of a deployment shares the deployment space; team ids are
 * already unique across orgs. */
function scopePrefix(scope: SecretScope, orgId: string): string {
  return scope.kind === "company" ? `company/${orgId}/` : referencePrefix(scope);
}

/** A replace imports the new value as `<name>@r<time>` before it deletes the
 * old one, so a failed import keeps the old value. `@` is not allowed in a
 * name, so a version never collides with another secret. */
const VERSION_SEPARATOR = "@r";

function baseName(stored: string): string {
  const at = stored.indexOf(VERSION_SEPARATOR);
  return at === -1 ? stored : stored.slice(0, at);
}

/** The stored names for one secret, newest first. */
function versionsOf(metas: SecretMeta[], fullName: string): SecretMeta[] {
  return metas.filter((m) => baseName(m.name) === fullName).sort((a, b) => b.createdAt - a.createdAt);
}

export function secretReference(scope: SecretScope, name: string): string {
  return `${SECRET_REFERENCE_PREFIX}${referencePrefix(scope)}${name}`;
}

/** The user who lists, saves, or deletes. Comes from the signed-in session. */
export interface SecretActor {
  orgId: string;
  userId: string;
}

/** Who asked for a value. Every field comes from the sandbox principal and
 * the session row, never from the request body. */
export interface SecretReadContext extends SecretActor {
  sessionId: string;
  sessionOwnerType: "user" | "team" | "org";
  sessionOwnerId: string;
}

export interface SaveOptions {
  replace?: boolean;
}

export interface SecretSummaryRow extends SecretMeta {
  reference: string;
}

export interface SecretStoreService {
  readonly enabled: boolean;
  /** The provider's name for users, or null when the store is off. */
  readonly providerLabel: string | null;
  list(actor: SecretActor, scope: SecretScope): Promise<SecretSummaryRow[]>;
  /** Start a save whose value the browser seals. `replace` allows a name
   * already in use. */
  beginSave(actor: SecretActor, scope: SecretScope, name: string, opts?: SaveOptions): Promise<SealEnvelope>;
  /** Finish a save with the sealed value. With `replace`, the old value is
   * deleted first: providers keep names unique and cannot edit in place. */
  finishSave(actor: SecretActor, scope: SecretScope, name: string, sealed: SealedValue, opts?: SaveOptions): Promise<SecretSummaryRow>;
  /** Save a value the api already holds (a key caught in an inbound message). */
  saveValue(actor: SecretActor, scope: SecretScope, name: string, value: string): Promise<SecretSummaryRow>;
  remove(actor: SecretActor, scope: SecretScope, name: string): Promise<void>;
  /** True when the reference names a saved secret this actor may list. */
  exists(actor: SecretActor, scope: SecretScope, name: string): Promise<boolean>;
  /** Whether a session may read the scope. Callers check every reference
   * before any read, so a command never starts with only some values. */
  mayRead(ctx: SecretReadContext, scope: SecretScope): Promise<boolean>;
  /** The value, or null when no secret has that name. Throws `forbidden`
   * when the session may not read the scope. */
  read(ctx: SecretReadContext, scope: SecretScope, name: string): Promise<string | null>;
}

const DISABLED_MESSAGE = "The secret store is not set up on this Valet. Ask an operator to set VALET_SECRET_STORE.";

export function disabledSecretStore(): SecretStoreService {
  const refuse = async (): Promise<never> => {
    throw new SecretStoreError(DISABLED_MESSAGE, "disabled");
  };
  return {
    enabled: false,
    providerLabel: null,
    list: refuse,
    beginSave: refuse,
    finishSave: refuse,
    saveValue: refuse,
    remove: refuse,
    exists: refuse,
    mayRead: refuse,
    read: refuse,
  };
}

/** Why a session may not read a scope, in words that name the fix. */
export function readRefusal(scope: SecretScope): string {
  if (scope.kind === "personal") {
    return "A secret://personal reference resolves only in a session you own personally. Start a personal session, then run again.";
  }
  if (scope.kind === "team") {
    return "A secret://team reference resolves only in that team's sessions or in a personal session of a team member. Check the team id in the reference.";
  }
  return "A secret://company reference resolves only in a session of this organization.";
}

export function createSecretStoreService(deps: {
  db: AppDb;
  provider: SecretStoreProvider;
  now?: () => number;
  log?: (msg: string, err: unknown) => void;
}): SecretStoreService {
  const { db, provider } = deps;
  const now = deps.now ?? Date.now;
  const log =
    deps.log ?? ((msg, err) => console.warn(`[secret-store:${provider.id}] ${msg}`, err instanceof Error ? err.message : err));

  /** A `SecretStoreError` passes through. Any other provider error is logged
   * and replaced: its text can echo request fields. */
  async function guarded<T>(action: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof SecretStoreError) throw err;
      log(`${action} failed`, err);
      throw new SecretStoreError(
        `${provider.label} could not ${action}. Try again. If it repeats, check the api logs.`,
        "provider",
      );
    }
  }

  async function existingPersonalSpace(q: AppQueryable, actor: SecretActor): Promise<string | null> {
    const rows = await q
      .select({ spaceId: secretStoreSpaces.spaceId })
      .from(secretStoreSpaces)
      .where(
        and(
          eq(secretStoreSpaces.orgId, actor.orgId),
          eq(secretStoreSpaces.ownerType, "user"),
          eq(secretStoreSpaces.ownerId, actor.userId),
          eq(secretStoreSpaces.provider, provider.id),
        ),
      )
      .limit(1);
    return rows[0]?.spaceId ?? null;
  }

  /** One personal space per user and provider. The advisory lock makes two
   * first saves wait for each other, so the second reads the row the first
   * wrote. If the provider created a space but the response was lost, the
   * next save creates another; the orphan holds no secret. */
  async function ensurePersonalSpace(actor: SecretActor): Promise<string> {
    const found = await existingPersonalSpace(db, actor);
    if (found) return found;
    return db.transaction(async (tx) => {
      const lockKey = `secret-store-space:${provider.id}:${actor.orgId}:user:${actor.userId}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
      const raced = await existingPersonalSpace(tx, actor);
      if (raced) return raced;
      const spaceId = await guarded("create your secret space", () => provider.createPersonalSpace(actor));
      await tx
        .insert(secretStoreSpaces)
        .values({ orgId: actor.orgId, ownerType: "user", ownerId: actor.userId, provider: provider.id, spaceId, createdAt: now() });
      return spaceId;
    });
  }

  /** The space a scope lives in; null when a personal space was never made. */
  async function spaceFor(actor: SecretActor, scope: SecretScope, create: boolean): Promise<string | null> {
    if (scope.kind !== "personal") return provider.deploymentSpace();
    return create ? ensurePersonalSpace(actor) : existingPersonalSpace(db, actor);
  }

  async function assertTeam(actor: SecretActor, teamId: string): Promise<void> {
    if (!(await getTeamInOrg(db, actor.orgId, teamId))) {
      throw new SecretStoreError("No team with that id in this organization.", "not_found");
    }
  }

  async function assertMayWrite(actor: SecretActor, scope: SecretScope): Promise<void> {
    if (scope.kind === "company" && !(await isOrgAdmin(db, actor.orgId, actor.userId))) {
      throw new SecretStoreError("Only an organization admin can change company secrets.", "forbidden");
    }
    if (scope.kind === "team") {
      await assertTeam(actor, scope.teamId);
      if (!(await isTeamMember(db, scope.teamId, actor.userId))) {
        throw new SecretStoreError("Only a member of this team can change its secrets.", "forbidden");
      }
    }
  }

  function assertName(name: string): void {
    if (!validSecretName(name)) {
      throw new SecretStoreError(
        `Name a secret with letters, digits, dot, dash, and underscore, in segments joined by "/", up to ${MAX_SECRET_NAME_LENGTH} characters.`,
        "invalid_name",
      );
    }
  }

  function assertValue(value: string): void {
    if (value.length === 0) throw new SecretStoreError("Enter a value to save.", "invalid_value");
    if (Buffer.byteLength(value, "utf8") > MAX_SECRET_VALUE_BYTES) {
      throw new SecretStoreError(`A secret can be at most ${MAX_SECRET_VALUE_BYTES / 1024} KB.`, "invalid_value");
    }
  }

  /** Labels the provider binds to the secret at import. Export policies
   * compare them with the read context. */
  function labelsFor(actor: SecretActor, scope: SecretScope): SecretLabels {
    const base = { scope: scope.kind, valet_company_org_id: actor.orgId, valet_created_by_user_id: actor.userId };
    if (scope.kind === "personal") return { ...base, valet_owner_user_id: actor.userId };
    if (scope.kind === "team") return { ...base, valet_owner_team_id: scope.teamId };
    return base;
  }

  function row(scope: SecretScope, name: string, createdAt: number): SecretSummaryRow {
    return { name, createdAt, reference: secretReference(scope, name) };
  }

  /** Validate, authorize, and refuse a name already in use. A value never
   * changes in place: the check turns a duplicate into an answer that says
   * what to do. Returns the stored names of the secret, newest first. */
  async function prepareSave(
    actor: SecretActor,
    scope: SecretScope,
    name: string,
    replace = false,
  ): Promise<{ spaceId: string; fullName: string; versions: SecretMeta[] }> {
    assertName(name);
    await assertMayWrite(actor, scope);
    const spaceId = (await spaceFor(actor, scope, true))!;
    const fullName = `${scopePrefix(scope, actor.orgId)}${name}`;
    const versions = versionsOf(await guarded("check the name", () => provider.list(spaceId, fullName)), fullName);
    if (versions.length > 0 && !replace) {
      throw new SecretStoreError(`A secret named ${name} already exists. Choose Replace to change its value.`, "exists");
    }
    return { spaceId, fullName, versions };
  }

  /** Delete each stored version. One failed delete leaves a stale version
   * that reads ignore, since they pick the newest. */
  async function removeVersions(spaceId: string, versions: SecretMeta[]): Promise<void> {
    for (const version of versions) {
      await guarded("remove the old value", () => provider.remove(spaceId, version.name));
    }
  }

  async function mayRead(ctx: SecretReadContext, scope: SecretScope): Promise<boolean> {
    if (scope.kind === "company") return true;
    if (scope.kind === "personal") return ctx.sessionOwnerType === "user" && ctx.sessionOwnerId === ctx.userId;
    if (!(await getTeamInOrg(db, ctx.orgId, scope.teamId))) return false;
    if (ctx.sessionOwnerType === "team") return ctx.sessionOwnerId === scope.teamId;
    return ctx.sessionOwnerType === "user" && ctx.sessionOwnerId === ctx.userId && isTeamMember(db, scope.teamId, ctx.userId);
  }

  return {
    enabled: true,
    providerLabel: provider.label,

    async list(actor, scope) {
      if (scope.kind === "team") await assertTeam(actor, scope.teamId);
      const spaceId = await spaceFor(actor, scope, false);
      if (!spaceId) return [];
      const prefix = scopePrefix(scope, actor.orgId);
      const metas = await guarded("list secrets", () => provider.list(spaceId, prefix));
      // One row per secret: the newest version of a replaced value.
      const newest = new Map<string, SecretMeta>();
      for (const meta of metas) {
        const base = baseName(meta.name);
        const seen = newest.get(base);
        if (!seen || meta.createdAt > seen.createdAt) newest.set(base, meta);
      }
      return [...newest.entries()].map(([base, meta]) => row(scope, base.slice(prefix.length), meta.createdAt));
    },

    async beginSave(actor, scope, name, opts) {
      const { spaceId } = await prepareSave(actor, scope, name, opts?.replace);
      return guarded("start the save", () => provider.beginImport(spaceId));
    },

    async finishSave(actor, scope, name, sealed, opts) {
      const { spaceId, fullName, versions } = await prepareSave(actor, scope, name, opts?.replace);
      // Import first, under a new version name, then delete the old ones:
      // a failed import leaves the old value in place.
      const storedName = versions.length > 0 ? `${fullName}${VERSION_SEPARATOR}${now()}` : fullName;
      await guarded("save the secret", () => provider.finishImport(spaceId, { name: storedName, sealed, labels: labelsFor(actor, scope) }));
      await removeVersions(spaceId, versions);
      return row(scope, name, now());
    },

    async saveValue(actor, scope, name, value) {
      assertValue(value);
      const { spaceId, fullName } = await prepareSave(actor, scope, name);
      await guarded("save the secret", () => provider.put(spaceId, { name: fullName, value, labels: labelsFor(actor, scope) }));
      return row(scope, name, now());
    },

    async remove(actor, scope, name) {
      assertName(name);
      await assertMayWrite(actor, scope);
      const notFound = new SecretStoreError(`No secret named ${name}.`, "not_found");
      const spaceId = await spaceFor(actor, scope, false);
      if (!spaceId) throw notFound;
      const fullName = `${scopePrefix(scope, actor.orgId)}${name}`;
      const versions = versionsOf(await guarded("find the secret", () => provider.list(spaceId, fullName)), fullName);
      if (versions.length === 0) throw notFound;
      await removeVersions(spaceId, versions);
    },

    async exists(actor, scope, name) {
      if (!validSecretName(name)) return false;
      const rows = await this.list(actor, scope);
      return rows.some((r) => r.name === name);
    },

    mayRead,

    async read(ctx, scope, name) {
      if (!(await mayRead(ctx, scope))) throw new SecretStoreError(readRefusal(scope), "forbidden");
      const spaceId = await spaceFor(ctx, scope, false);
      if (!spaceId) return null;
      const fullName = `${scopePrefix(scope, ctx.orgId)}${name}`;
      const newest = versionsOf(await guarded("find the secret", () => provider.list(spaceId, fullName)), fullName)[0];
      if (!newest) return null;
      return guarded("read the secret", () =>
        provider.read(spaceId, newest.name, {
          valet_company_org_id: ctx.orgId,
          valet_user_id: ctx.userId,
          valet_session_id: ctx.sessionId,
          valet_session_owner_type: ctx.sessionOwnerType,
          valet_session_owner_id: ctx.sessionOwnerId,
          ...(scope.kind === "team" ? { valet_owner_team_id: scope.teamId } : {}),
        }),
      );
    },
  };
}
