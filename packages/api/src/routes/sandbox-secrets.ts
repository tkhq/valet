/**
 * The secret broker a sandbox CLI talks to.
 *
 * The shape is Infisical's: an agent never reads a secret, it says where one
 * should be delivered. `valet-secrets run --env GITHUB_TOKEN=op://… -- cmd`
 * resolves the reference here, and the CLI puts the value in the child
 * process's environment. The value crosses this boundary once, into a process
 * the model does not read, and never enters the transcript.
 *
 * Auth is the `x-valet-sandbox` rung in `middleware/auth.ts`, which verifies
 * the token every sandbox is started with and sets `c.var.sandbox`. This
 * route requires that principal and reads the org and user from it, never
 * from a header or a cookie, so a leaked token is worth its remaining
 * lifetime for one session's principal and nothing else.
 */
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import { agentSessions } from "../schema/index.js";
import { onePasswordScopesFor, resolveAcrossScopes } from "../services/credential-resolution.js";
import { isOnePasswordReference, OnePasswordAuthError, type OnePasswordScope } from "../services/onepassword.js";
import { classifySecurityBrokerCaller, loadEngagementCredentialRefs } from "../services/security-broker-allowlist.js";
import { registerSecurityCredentialValue } from "../services/security-credential-tripwire.js";
import { getTeamInOrg, listTeamsForUser } from "../services/teams.js";
import { SecretStoreError } from "../services/secret-store/provider.js";
import {
  isSecretReference,
  parseSecretReference,
  readRefusal,
  type SecretReadContext,
  type SecretScope,
  type SecretStoreService,
} from "../services/secret-store/service.js";
import { recordSecretUse } from "../services/secret-use-log.js";
import { workflowSessionOwner } from "../workflows/session-owner.js";
import type { AppQueryable } from "../lib/drizzle.js";
import type { ResolveSandboxSecretsResponse } from "../wire/types.js";

export const sandboxSecretsRouter = new Hono<AppEnv>();

// References this broker resolves: 1Password on the one `op://` grammar
// `services/onepassword.ts` exports (`isOnePasswordReference`), and personal
// secrets in the configured secret store as `secret://personal/<name>`
// (`services/secret-store/`).

/** One `run` injecting hundreds of secrets is a mistake, and each reference
 * costs a round trip. */
const MAX_REFERENCES = 25;

/** A search term, not a document. Bounds the enumeration surface too. */
const MAX_QUERY_LENGTH = 200;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * The scopes one request may consult: what the owner rule allows, narrowed by
 * an explicit `scope` when the caller sent one.
 *
 * Narrowed, never widened. The owner rule is the security control; `scope` is
 * the caller saying which of its allowed scopes it meant, which matters once
 * an org and a personal token are both connected, because the org token is
 * tried first and silently answers anything it can read. Asking for a scope
 * the rule excludes is refused by name rather than answered with nothing,
 * since "nothing resolved" would send the reader to check vault names that
 * were correct.
 */
function narrowScopes(
  allowed: readonly OnePasswordScope[],
  requested: unknown,
): { ok: true; scopes: readonly OnePasswordScope[] } | { ok: false; error: string } {
  if (requested === undefined) return { ok: true, scopes: allowed };
  if (requested !== "org" && requested !== "personal" && requested !== "team") {
    return { ok: false, error: "scope must be org, personal, or team" };
  }
  if (!allowed.includes(requested)) {
    return {
      ok: false,
      error:
        requested === "personal"
          ? "This session cannot use a personal 1Password token. Start a session you own personally."
          : `this session cannot use the ${requested} scope.`,
    };
  }
  return { ok: true, scopes: [requested] };
}

sandboxSecretsRouter.post("/resolve", async (c) => {
  const { onePassword, db } = c.var.providers;
  // The sandbox principal, never `c.var.user`: the sandbox rung sets only
  // `c.var.sandbox`, and a signed-in browser session must not read plaintext
  // org secrets from a route whose sibling deliberately strips values.
  const sandbox = c.var.sandbox;
  if (!sandbox) {
    return c.json(
      {
        error:
          "this endpoint answers a sandbox only. Run valet-secrets inside a session, or send the session's x-valet-sandbox token.",
      },
      401,
    );
  }

  let body: { references?: unknown; scope?: unknown };
  try {
    body = (await c.req.json()) as { references?: unknown; scope?: unknown };
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const references = body.references;
  if (!isStringArray(references)) {
    return c.json({ error: "references must be an array of strings" }, 400);
  }
  if (references.length > MAX_REFERENCES) {
    return c.json({ error: `at most ${MAX_REFERENCES} references per request` }, 400);
  }
  // Every bad reference, not the first: the CLI rejects the whole batch on
  // this error, and naming one of several sends the reader to debug a
  // reference that was fine.
  const unsupported = references.filter((r) => !isOnePasswordReference(r) && !parseSecretReference(r));
  if (unsupported.length > 0) {
    return c.json(
      {
        error: `not a supported secret reference: ${unsupported.join(", ")}. Use op://vault/item/field, or secret://personal/NAME, secret://team/TEAM_ID/NAME, or secret://company/NAME.`,
      },
      400,
    );
  }

  // The token carries the actor frozen onto the session, not its owner. A
  // team- or org-owned session may be prompted by anyone in the group, so its
  // reads never reach the frozen actor's personal vault. One policy, shared
  // with the api-side resolver: `onePasswordScopesFor`.
  const row = await sessionOwnerRow(db, sandbox);
  // The personal scope belongs to the identity the token was minted for, not
  // to a user-owned row in the abstract. A session can change hands
  // (`PATCH /api/sessions/:id`) while tokens minted before the move stay
  // valid for their full TTL — revocation is reserved for `destroy` — so
  // reading `ownerType` alone would let whoever takes ownership present the
  // earlier actor's token and resolve that actor's personal vault. `undefined`
  // is the unknown-owner case `onePasswordScopesFor` already answers with the
  // org scope alone. A validated team owner additionally permits team scope.
  // `owner_id` carries a DEFAULT '' and rows predating the owner columns
  // still hold it, so a user-owned row names its owner in `user_id` — the
  // same `NULLIF(owner_id, '')` fallback `SCHEMA_REPAIRS` uses. A personal
  // owner move rewrites both columns, so this cannot re-open the gap above.
  const ownerUserId = row?.ownerType === "user" ? row.ownerId || row.userId : undefined;
  const isOwnUserSession = ownerUserId !== undefined && ownerUserId === sandbox.userId;
  const teamId = row?.ownerType === "team" && row.ownerId ? row.ownerId : undefined;
  if (row?.ownerType === "team" && (!teamId || !(await getTeamInOrg(db, sandbox.orgId, teamId)))) {
    return c.json({ error: teamNotFound(row.workflow) }, 403);
  }
  const allowed = onePasswordScopesFor(teamId ? "team" : isOwnUserSession ? "user" : undefined, teamId);
  const narrowed = narrowScopes(allowed, body.scope);
  if (!narrowed.ok) return c.json({ error: narrowed.error }, 403);
  const scopes = narrowed.scopes;
  const ctx = { orgId: sandbox.orgId, userId: sandbox.userId, teamId };

  // Each secret:// reference is checked against the session before any read,
  // and the batch fails on the first refusal, so the command never starts
  // with only some of its secrets. The read context comes from the token and
  // the session row, never from the request body. A personal scope follows
  // the personal 1Password rule: the token holder must own the session.
  const { secretStore } = c.var.providers;
  const readCtx: SecretReadContext = {
    orgId: sandbox.orgId,
    userId: sandbox.userId,
    sessionId: sandbox.sessionId,
    sessionOwnerType: teamId ? "team" : isOwnUserSession ? "user" : "org",
    sessionOwnerId: teamId ?? (isOwnUserSession ? sandbox.userId : sandbox.orgId),
  };
  if (references.some(isSecretReference)) {
    if (!secretStore.enabled) {
      return c.json(
        { error: "The secret store is not set up on this Valet. Ask an operator to set VALET_SECRET_STORE, or use an op:// reference." },
        503,
      );
    }
    for (const reference of references) {
      const parsed = parseSecretReference(reference);
      if (parsed && !(await secretStore.mayRead(readCtx, parsed.scope))) {
        return c.json({ error: readRefusal(parsed.scope) }, 403);
      }
    }
  }

  // Per-engagement allowlist (Part 12 §Broker allowlist enforcement, INV-34).
  // A security persona's child sandbox is claimed by a `security_cells` row;
  // every other caller (workflow, coding session, orchestrator) claims none
  // and bypasses this block entirely, unaffected. This runs before any
  // `resolveReference` call: a reference that fails the allowlist must not
  // reach 1Password, or a rejected reference would already have leaked its
  // value into api memory.
  const securityCaller = await classifySecurityBrokerCaller(db, sandbox.sessionId);
  if (securityCaller.kind === "security-session-denied") {
    return c.json(
      { error: "Only a running security persona cell may resolve engagement credentials." },
      403,
    );
  }
  const engagementId =
    securityCaller.kind === "running-cell" ? securityCaller.engagementId : null;
  if (engagementId !== null) {
    const allowlist = await loadEngagementCredentialRefs(db, engagementId);
    const disallowed = references.filter((ref) => !allowlist.has(ref));
    if (disallowed.length > 0) {
      return c.json(
        {
          error: `The following op:// references are not declared on this engagement: ${disallowed.join(", ")}.`,
          code: "credential_ref_not_allowlisted",
        },
        403,
      );
    }
  }

  // Every reference in parallel, within the owner's ordered scopes. An
  // absent team token permits org fallback; a configured team refusal does not.
  // A non-team scope with no token has nothing to offer and the next may
  // answer. A token that exists and is refused by 1Password is a different
  // failure, and reporting it as "nothing resolved" sent the reader to check
  // vault names that were correct.
  //
  // `reference` is the third case and must not read as the second: the token
  // worked and the reference did not resolve, so the name is what to check.
  // The real SDK reports an unknown vault or item that way, and calling it a
  // refused token sent the reader to rotate a token that was fine.
  let sdkRefused = false;
  let teamRefused = false;
  const storeErrors: SecretStoreError[] = [];
  const values = await Promise.all(
    references.map(async (reference): Promise<string | null> => {
      const parsed = parseSecretReference(reference);
      if (parsed) {
        try {
          const value = await secretStore.read(readCtx, parsed.scope, parsed.name);
          return value === null ? null : Buffer.from(value, "utf8").toString("base64");
        } catch (err) {
          if (!(err instanceof SecretStoreError)) throw err;
          storeErrors.push(err);
          return null;
        }
      }
      const outcome = await resolveAcrossScopes(onePassword, scopes, ctx, reference);
      if ("value" in outcome) {
        if (engagementId !== null) {
          registerSecurityCredentialValue(sandbox.sessionId, engagementId, outcome.value);
        }
        return Buffer.from(outcome.value, "utf8").toString("base64");
      }
      for (const { scope, error } of outcome.attempts) {
        if (scope === "team" && !(error instanceof OnePasswordAuthError && error.kind === "no_token")) {
          teamRefused = true;
          break;
        }
        if (error instanceof OnePasswordAuthError && error.kind === "sdk") sdkRefused = true;
      }
      return null;
    }),
  );

  // One failed secret store read fails the run: a command must not start
  // with only some of the secrets it named.
  if (storeErrors[0]) {
    // A refusal (a use-only secret, a provider policy) is the caller's to fix.
    return c.json({ error: storeErrors[0].message }, storeErrors[0].kind === "forbidden" ? 403 : 502);
  }
  if (teamRefused) {
    return c.json({ error: "Team 1Password could not resolve the reference. Check the team token and its vault permissions." }, 502);
  }
  if (sdkRefused && values.every((v) => v === null)) {
    return c.json(
      {
        error:
          "1Password refused the request. Check the service account token in Organization settings, then run again.",
      },
      502,
    );
  }

  const resp: ResolveSandboxSecretsResponse = {
    values,
    // Named, not thrown: the CLI decides whether a missing one is fatal, and
    // says WHICH reference failed rather than "the run failed".
    unresolved: references.filter((r, i) => values[i] === null),
  };
  return c.json(resp);
});

/**
 * `POST /find` — items whose title names a query, as references.
 *
 * Names only: vault, item, and the field segment a reference would address.
 * No value crosses this route, which is what separates it from `/resolve`.
 * It exists because naming a destination is useless if you do not know the
 * destination: an agent told "use my Claude API key" had no way to turn that
 * into `op://…`, and guessed, and read the guess's failure as no access.
 *
 * The response is TEXT, one candidate per line, because the caller is a POSIX
 * shell with no JSON parser. Everything here is a title, so there is nothing
 * a plain-text line can leak.
 */
sandboxSecretsRouter.post("/find", async (c) => {
  const { onePassword, db } = c.var.providers;
  const sandbox = c.var.sandbox;
  if (!sandbox) {
    return c.json(
      {
        error:
          "this endpoint answers a sandbox only. Run valet-secrets inside a session, or send the session's x-valet-sandbox token.",
      },
      401,
    );
  }

  let body: { query?: unknown; scope?: unknown };
  try {
    body = (await c.req.json()) as { query?: unknown; scope?: unknown };
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const query = body.query;
  if (typeof query !== "string" || query.trim() === "") {
    // A blank query would list the vaults, which this surface does not offer.
    return c.json({ error: "query must be a non-empty string naming the credential to look for. Pass * to list the saved secrets this session can read." }, 400);
  }
  // `*` lists the secret store names this session may read. It never lists
  // 1Password: vault and item titles stay behind a named search.
  const listAll = query.trim() === "*";
  if (query.length > MAX_QUERY_LENGTH) {
    return c.json({ error: `query must be ${MAX_QUERY_LENGTH} characters or fewer` }, 400);
  }

  const row = await sessionOwnerRow(db, sandbox);
  const ownerUserId = row?.ownerType === "user" ? row.ownerId || row.userId : undefined;
  const isOwnUserSession = ownerUserId !== undefined && ownerUserId === sandbox.userId;
  const teamId = row?.ownerType === "team" && row.ownerId ? row.ownerId : undefined;
  if (row?.ownerType === "team" && (!teamId || !(await getTeamInOrg(db, sandbox.orgId, teamId)))) {
    return c.json({ error: teamNotFound(row.workflow) }, 403);
  }
  const allowed = onePasswordScopesFor(teamId ? "team" : isOwnUserSession ? "user" : undefined, teamId);
  const narrowed = narrowScopes(allowed, body.scope);
  if (!narrowed.ok) return c.json({ error: narrowed.error }, 403);

  // Discovery uses the same lifecycle boundary as resolution. A security
  // runner or stale child must not enumerate vault, item, or field names.
  const securityCaller = await classifySecurityBrokerCaller(db, sandbox.sessionId);
  if (securityCaller.kind === "security-session-denied") {
    return c.json(
      { error: "Only a running security persona cell may search for engagement credentials." },
      403,
    );
  }

  const ctx = { orgId: sandbox.orgId, userId: sandbox.userId, teamId };
  const lines: string[] = [];
  const { secretStore } = c.var.providers;
  // A running security cell resolves only its engagement's allowlist, so it
  // gets no saved-secret names either: listing them would name credentials
  // `/resolve` refuses it.
  if (secretStore.enabled && securityCaller.kind === "non-security") {
    const readCtx: SecretReadContext = {
      orgId: sandbox.orgId,
      userId: sandbox.userId,
      sessionId: sandbox.sessionId,
      sessionOwnerType: teamId ? "team" : isOwnUserSession ? "user" : "org",
      sessionOwnerId: teamId ?? (isOwnUserSession ? sandbox.userId : sandbox.orgId),
    };
    const memberTeamIds = isOwnUserSession
      ? (await listTeamsForUser(db, sandbox.userId)).filter((t) => t.orgId === sandbox.orgId).map((t) => t.id)
      : [];
    try {
      lines.push(...(await findSavedSecrets(secretStore, readCtx, teamId, memberTeamIds, listAll ? null : query)));
    } catch (err) {
      if (!(err instanceof SecretStoreError)) throw err;
      // `*` asks only the store, so its failure is the answer. A named search
      // still has 1Password to ask, and a store outage must not hide a hit there.
      if (listAll) return c.json({ error: `The secret store could not list saved secrets: ${err.message}` }, 502);
      console.warn("sandbox-secrets: saved-secret search failed; searching 1Password only", err.message);
    }
  }
  if (listAll) return c.text(lines.join("\n"), 200, { "content-type": "text/plain; charset=utf-8" });
  for (const scope of narrowed.scopes) {
    try {
      for (const cand of await onePassword.findCandidates(scope, ctx, query)) {
        const reference = `op://${cand.vault}/${cand.item}/${cand.field}`;
        // Scope-tagged, because the same name can sit in an org vault and a
        // personal one, and the resolver takes the org copy first. Seeing both
        // is how a caller knows to pass --scope.
        lines.push(`${scope}\t${reference}`);
      }
      if (scope === "team") break;
    } catch (err) {
      if (scope === "team" && !(err instanceof OnePasswordAuthError && err.kind === "no_token")) {
        return c.json({ error: "Team 1Password discovery failed. Check the team token and its vault permissions." }, 502);
      }
      // A scope with no token, or one the SDK refused, has nothing to
      // contribute to a search; the next scope may.
    }
  }

  return c.text(lines.join("\n"), 200, { "content-type": "text/plain; charset=utf-8" });
});

/** Largest outbound request body `/use` forwards. */
const MAX_USE_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Uses a use-only secret through the secret use service (broker design,
 * "Using a secret without exporting it"). The sandbox sends the reference and
 * the request with the secret's header removed; the use service puts the
 * secret in that header, makes the call, and returns the scrubbed response.
 * Neither the api nor the sandbox holds the value. The session rule is the
 * one `/resolve` applies.
 */
sandboxSecretsRouter.post("/use", async (c) => {
  const { db, secretStore, secretUse } = c.var.providers;
  const sandbox = c.var.sandbox;
  if (!sandbox) {
    return c.json({ error: "this endpoint answers a sandbox only. Run valet-secrets http inside a session." }, 401);
  }
  if (!secretStore.enabled || !secretUse) {
    return c.json({ error: "This Valet has no secret use service. Use valet-secrets run --env with a saved secret instead." }, 503);
  }
  let body: { reference?: unknown; header?: unknown; request?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const parsed = typeof body.reference === "string" ? parseSecretReference(body.reference) : null;
  if (!parsed) {
    return c.json({ error: "reference must be a secret:// reference, such as secret://personal/NAME." }, 400);
  }
  const req = body.request;
  if (
    typeof req !== "object" || req === null ||
    typeof (req as Record<string, unknown>).method !== "string" ||
    typeof (req as Record<string, unknown>).url !== "string"
  ) {
    return c.json({ error: "request must carry method and url." }, 400);
  }
  const r = req as Record<string, unknown>;
  const headers: Record<string, string> = {};
  if (r.headers !== undefined) {
    if (typeof r.headers !== "object" || r.headers === null) return c.json({ error: "request.headers must be an object." }, 400);
    for (const [k, v] of Object.entries(r.headers)) {
      if (typeof v !== "string") return c.json({ error: `header ${k} must be text.` }, 400);
      headers[k.toLowerCase()] = v;
    }
  }
  const requestBody = typeof r.body === "string" ? r.body : "";
  if (Buffer.byteLength(requestBody, "base64") > MAX_USE_BODY_BYTES) {
    return c.json({ error: "The request body is over 10 MB." }, 413);
  }

  const row = await sessionOwnerRow(db, sandbox);
  const ownerUserId = row?.ownerType === "user" ? row.ownerId || row.userId : undefined;
  const isOwnUserSession = ownerUserId !== undefined && ownerUserId === sandbox.userId;
  const teamId = row?.ownerType === "team" && row.ownerId ? row.ownerId : undefined;
  if (row?.ownerType === "team" && (!teamId || !(await getTeamInOrg(db, sandbox.orgId, teamId)))) {
    return c.json({ error: teamNotFound(row.workflow) }, 403);
  }
  const readCtx: SecretReadContext = {
    orgId: sandbox.orgId,
    userId: sandbox.userId,
    sessionId: sandbox.sessionId,
    sessionOwnerType: teamId ? "team" : isOwnUserSession ? "user" : "org",
    sessionOwnerId: teamId ?? (isOwnUserSession ? sandbox.userId : sandbox.orgId),
  };
  // A security persona resolves only its engagement allowlist of op://
  // references, so it may not use saved secrets either.
  const securityCaller = await classifySecurityBrokerCaller(db, sandbox.sessionId);
  if (securityCaller.kind !== "non-security") {
    return c.json({ error: "A security persona cannot use saved secrets. Use the engagement's declared credentials." }, 403);
  }

  let lookup;
  try {
    lookup = await secretStore.findForUse(readCtx, parsed.scope, parsed.name);
  } catch (err) {
    if (!(err instanceof SecretStoreError)) throw err;
    return c.json({ error: err.message }, err.kind === "forbidden" ? 403 : err.kind === "invalid_value" ? 400 : 502);
  }
  if (!lookup) {
    return c.json({ error: `Nothing is saved as ${body.reference}. Run valet-secrets find '*' to list saved secrets.` }, 404);
  }
  if (typeof body.header === "string" && body.header.toLowerCase() !== lookup.use.header) {
    return c.json(
      { error: `${parsed.name} goes in the ${lookup.use.header} header, not ${body.header}. Put the placeholder in ${lookup.use.header}.` },
      400,
    );
  }

  const result = await secretUse.use(
    { spaceId: lookup.spaceId, secretId: lookup.secretId, owner: lookup.owner, context: lookup.context },
    { method: r.method as string, url: r.url as string, headers, body: requestBody },
  );
  if (!result.ok) {
    // The use service's refusal status (403 rule, 404 deleted, 409 approval)
    // tells the agent what to fix, so it passes through.
    const status = (result.httpStatus >= 400 && result.httpStatus < 600 ? result.httpStatus : 502) as ContentfulStatusCode;
    return c.json({ error: result.message, code: result.error }, status);
  }
  // The receipt is the audit record: the use service signed which secret went
  // to which host and path, under which provider export activity.
  console.info(
    JSON.stringify({ event: "secret_use", sessionId: sandbox.sessionId, reference: body.reference, status: result.status, receipt: result.receipt.payload }),
  );
  const target = new URL(r.url as string);
  const signer = secretUse.attested ? "enclave" : "use service";
  await recordSecretUse(db, {
    orgId: sandbox.orgId,
    owner: lookup.owner,
    secretName: parsed.name,
    sessionId: sandbox.sessionId,
    method: r.method as string,
    host: target.hostname,
    path: target.pathname,
    status: result.status,
    signer,
    receipt: result.receipt,
  });
  return c.json({ status: result.status, headers: result.headers, body: result.body, receipt: result.receipt, secret: parsed.name, signer });
});

/**
 * Saved secrets whose name contains every word of the query (any name when
 * the query is null; none when it has no letter or digit), as
 * `secret://` references tagged `saved`. Only scopes the session may read are
 * listed, with the same `mayRead` rule `/resolve` applies, so every line is a
 * reference `run` accepts here: a team session sees its team and the company,
 * and a personal session sees its owner's personal secrets, the owner's
 * teams, and the company.
 */
async function findSavedSecrets(
  store: SecretStoreService,
  ctx: SecretReadContext,
  sessionTeamId: string | undefined,
  memberTeamIds: string[],
  query: string | null,
): Promise<string[]> {
  const scopes: SecretScope[] = [{ kind: "company" }];
  if (sessionTeamId) scopes.push({ kind: "team", teamId: sessionTeamId });
  if (ctx.sessionOwnerType === "user") {
    scopes.push({ kind: "personal" });
    for (const teamId of memberTeamIds) scopes.push({ kind: "team", teamId });
  }
  // Words, not one string: a person says "test key" for VALET_TEST_KEY, so
  // every word of the query must appear in the name, in any order.
  const words = query === null ? null : query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const lines: string[] = [];
  for (const scope of scopes) {
    if (!(await store.mayRead(ctx, scope))) continue;
    for (const row of await store.list(ctx, scope)) {
      const name = row.name.toLowerCase();
      if (words === null || (words.length > 0 && words.every((word) => name.includes(word)))) {
        // A use-only secret carries where it may be sent, as a third field.
        lines.push(row.use ? `saved\t${row.reference}\tuse ${row.use.hosts.join(",")} ${row.use.header}` : `saved\t${row.reference}`);
      }
    }
  }
  return lines;
}

/**
 * The owner columns the scope rule reads. A coding session has an
 * `agent_sessions` row. A workflow session has none, so its owner comes from
 * its run (`workflows/session-owner.ts`), with `userId` set to that owner for
 * a user owner. The personal scope then opens only when the token holder is
 * the run owner. That holds for every run of a user-owned workflow, because
 * an unattended start mints the token for the owner. A workflow session
 * whose run cannot be read gets no row, which the rule answers with the org
 * scope. `workflow` selects the wording of the team-not-found refusal.
 */
async function sessionOwnerRow(
  db: AppQueryable,
  sandbox: { sessionId: string; orgId: string },
): Promise<{ ownerType: string; ownerId: string; userId: string; workflow: boolean } | undefined> {
  const rows = await db
    .select({
      ownerType: agentSessions.ownerType,
      ownerId: agentSessions.ownerId,
      userId: agentSessions.userId,
    })
    .from(agentSessions)
    .where(and(eq(agentSessions.id, sandbox.sessionId), eq(agentSessions.orgId, sandbox.orgId)))
    .limit(1);
  if (rows[0]) return { ...rows[0], workflow: false };
  const owner = await workflowSessionOwner(db, sandbox.sessionId, sandbox.orgId);
  if (!owner) return undefined;
  return { ownerType: owner.type, ownerId: owner.id, userId: owner.type === "user" ? owner.id : "", workflow: true };
}

/** The refusal for a team-owned session whose team is gone. A coding
 * session can be restarted under an existing team. A workflow run cannot, so
 * its message names the workflow. */
function teamNotFound(workflow: boolean): string {
  return workflow
    ? "The team that owns this workflow no longer exists. Run the workflow from an existing team."
    : "Team not found. Start a new team session.";
}
