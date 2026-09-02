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
import { OnePasswordAuthError } from "../services/onepassword.js";
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
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

  let body: { references?: unknown };
  try {
    body = (await c.req.json()) as { references?: unknown };
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
    .select({ ownerType: agentSessions.ownerType })
    .from(agentSessions)
    .where(eq(agentSessions.id, sandbox.sessionId))
    .limit(1);
  const scopes = onePasswordScopesFor(rows[0]?.ownerType);
  const ctx = { orgId: sandbox.orgId, userId: sandbox.userId };

  // Every reference in parallel; within one, org scope first. A scope with
  // no token or a disabled toggle has nothing to offer and the next may
  // answer. A token that exists and is refused by 1Password is a different
  // failure, and reporting it as "nothing resolved" sent the reader to check
  // vault names that were correct.
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
