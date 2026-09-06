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
import { eq } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import { agentSessions } from "../schema/index.js";
import { onePasswordScopesFor } from "../services/credential-resolution.js";
import { OnePasswordAuthError, type OnePasswordScope } from "../services/onepassword.js";
import {
  isTeamOpRefGranted,
  loadTeamOnePasswordRefs,
  UNGRANTED_TEAM_OP_REF,
} from "../services/team-onepassword-grant.js";
import type { ResolveSandboxSecretsResponse } from "../wire/types.js";

export const sandboxSecretsRouter = new Hono<AppEnv>();

/**
 * References this broker resolves. Only 1Password today.
 *
 * `op://vault/item/field` or `op://vault/item/section/field`, the two forms
 * the 1Password SDK accepts. Segments may contain spaces ("ProDex Labs" is an
 * ordinary vault name) but not a slash or a control character. The prefix and
 * the segment count are what keep this from becoming a general read
 * primitive: a path, an env var name, or a URL does not match.
 */
const REFERENCE = /^op:\/\/[^/\u0000-\u001f]+\/[^/\u0000-\u001f]+(?:\/[^/\u0000-\u001f]+){1,2}$/;

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
  if (requested !== "org" && requested !== "personal") {
    return { ok: false, error: "scope must be org or personal" };
  }
  if (!allowed.includes(requested)) {
    return {
      ok: false,
      error:
        requested === "personal"
          ? "this session reads organization vaults only, so it cannot use a personal 1Password token. A session you own personally can."
          : `this session cannot use the ${requested} scope.`,
    };
  }
  return { ok: true, scopes: [requested] };
}

sandboxSecretsRouter.post("/resolve", async (c) => {
  const { onePassword, db, engineCredentials } = c.var.providers;
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
  const unsupported = references.filter((r) => !REFERENCE.test(r));
  if (unsupported.length > 0) {
    return c.json(
      {
        error: `not a supported secret reference: ${unsupported.join(", ")}. Use op://vault/item/field.`,
      },
      400,
    );
  }

  // The token carries the actor frozen onto the session, not its owner. A
  // team- or org-owned session may be prompted by anyone in the group, so its
  // reads never reach the frozen actor's personal vault. One policy, shared
  // with the api-side resolver: `onePasswordScopesFor`.
  const rows = await db
    .select({
      ownerType: agentSessions.ownerType,
      ownerId: agentSessions.ownerId,
      userId: agentSessions.userId,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sandbox.sessionId))
    .limit(1);
  // The personal scope belongs to the identity the token was minted for, not
  // to a user-owned row in the abstract. A session can change hands
  // (`PATCH /api/sessions/:id`) while tokens minted before the move stay
  // valid for their full TTL — revocation is reserved for `destroy` — so
  // reading `ownerType` alone would let whoever takes ownership present the
  // earlier actor's token and resolve that actor's personal vault. `undefined`
  // is the unknown-owner case `onePasswordScopesFor` already answers with the
  // org scope alone, which is also the right answer for a team- or org-owned
  // session and for a user-owned one that is not this token holder's.
  // `owner_id` carries a DEFAULT '' and rows predating the owner columns
  // still hold it, so a user-owned row names its owner in `user_id` — the
  // same `NULLIF(owner_id, '')` fallback `SCHEMA_REPAIRS` uses. A personal
  // owner move rewrites both columns, so this cannot re-open the gap above.
  const row = rows[0];
  const ownerUserId = row?.ownerType === "user" ? row.ownerId || row.userId : undefined;
  const isOwnUserSession = ownerUserId !== undefined && ownerUserId === sandbox.userId;
  const allowed = onePasswordScopesFor(isOwnUserSession ? "user" : undefined);
  const narrowed = narrowScopes(allowed, body.scope);
  if (!narrowed.ok) return c.json({ error: narrowed.error }, 403);
  const scopes = narrowed.scopes;
  const ctx = { orgId: sandbox.orgId, userId: sandbox.userId };
  const teamId = row?.ownerType === "team" && row.ownerId ? row.ownerId : undefined;
  if (teamId) {
    const granted = await loadTeamOnePasswordRefs(engineCredentials, teamId);
    const ungranted = references.filter((reference) => !isTeamOpRefGranted(granted, reference));
    if (ungranted.length > 0) {
      return c.json({ error: UNGRANTED_TEAM_OP_REF }, 403);
    }
  }

  // Every reference in parallel; within one, org scope first. A scope with
  // no token or a disabled toggle has nothing to offer and the next may
  // answer. A token that exists and is refused by 1Password is a different
  // failure, and reporting it as "nothing resolved" sent the reader to check
  // vault names that were correct.
  //
  // `reference` is the third case and must not read as the second: the token
  // worked and the reference did not resolve, so the name is what to check.
  // The real SDK reports an unknown vault or item that way, and calling it a
  // refused token sent the reader to rotate a token that was fine.
  let sdkRefused = false;
  const values = await Promise.all(
    references.map(async (reference): Promise<string | null> => {
      for (const scope of scopes) {
        try {
          const value = await onePassword.resolveReference(scope, ctx, reference);
          return Buffer.from(value, "utf8").toString("base64");
        } catch (err) {
          if (err instanceof OnePasswordAuthError && err.kind === "sdk") sdkRefused = true;
        }
      }
      return null;
    }),
  );

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
  const { onePassword, db, engineCredentials } = c.var.providers;
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
    return c.json({ error: "query must be a non-empty string naming the credential to look for" }, 400);
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return c.json({ error: `query must be ${MAX_QUERY_LENGTH} characters or fewer` }, 400);
  }

  const rows = await db
    .select({
      ownerType: agentSessions.ownerType,
      ownerId: agentSessions.ownerId,
      userId: agentSessions.userId,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sandbox.sessionId))
    .limit(1);
  const row = rows[0];
  const ownerUserId = row?.ownerType === "user" ? row.ownerId || row.userId : undefined;
  const isOwnUserSession = ownerUserId !== undefined && ownerUserId === sandbox.userId;
  const allowed = onePasswordScopesFor(isOwnUserSession ? "user" : undefined);
  const narrowed = narrowScopes(allowed, body.scope);
  if (!narrowed.ok) return c.json({ error: narrowed.error }, 403);

  const ctx = { orgId: sandbox.orgId, userId: sandbox.userId };
  const teamId = row?.ownerType === "team" && row.ownerId ? row.ownerId : undefined;
  const granted = teamId ? await loadTeamOnePasswordRefs(engineCredentials, teamId) : undefined;
  const lines: string[] = [];
  for (const scope of narrowed.scopes) {
    try {
      for (const cand of await onePassword.findCandidates(scope, ctx, query)) {
        const reference = `op://${cand.vault}/${cand.item}/${cand.field}`;
        if (granted && !isTeamOpRefGranted(granted, reference)) continue;
        // Scope-tagged, because the same name can sit in an org vault and a
        // personal one, and the resolver takes the org copy first. Seeing both
        // is how a caller knows to pass --scope.
        lines.push(`${scope}\t${reference}`);
      }
    } catch {
      // A scope with no token, a disabled toggle, or an SDK refusal has
      // nothing to contribute to a search; the next scope may.
    }
  }

  return c.text(lines.join("\n"), 200, { "content-type": "text/plain; charset=utf-8" });
});
