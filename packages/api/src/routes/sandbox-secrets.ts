/**
 * The secret broker a sandbox CLI talks to.
 *
 * The shape is Infisical's: an agent never reads a secret, it says where one
 * should be delivered. `valet secrets run --env GITHUB_TOKEN=op://… -- cmd`
 * resolves the reference here, and the CLI puts the value in the child
 * process's environment. The value crosses this boundary once, into a process
 * the model does not read, and never enters the transcript.
 *
 * No bespoke auth: the ladder in `middleware/auth.ts` accepts the
 * `x-valet-sandbox` token every sandbox is started with and sets
 * `c.var.sandbox`. This route requires that principal and reads the org and
 * user from it, never from a header or a cookie. So the credential is
 * agent-scoped and time-boxed by construction — a leaked token is worth its
 * remaining lifetime, for one session's principal, and nothing else.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { ResolveSandboxSecretsResponse } from "../wire/types.js";

export const sandboxSecretsRouter = new Hono<AppEnv>();

/**
 * References this broker resolves. Only 1Password today; the runner's
 * `SecretsProvider` seam is where a second one would land.
 *
 * `vault/item/field`, and the segments may contain SPACES — a vault called
 * "ProDex Labs" is ordinary, and an earlier `[^\s]+` rejected every reference
 * into one. What the prefix and the three segments rule out is the thing that
 * matters: a path, an env var name or a URL, any of which would turn the
 * broker into a general read primitive.
 */
const REFERENCE = /^op:\/\/[^/\n\r]+\/[^/\n\r]+\/[^/\n\r]+$/;

/** One `run` injecting hundreds of secrets is a mistake, and each reference
 * costs a round trip. */
const MAX_REFERENCES = 25;

sandboxSecretsRouter.post("/resolve", async (c) => {
  const { onePassword } = c.var.providers;
  // The SANDBOX principal, never `c.var.user`. The sandbox rung of the auth
  // ladder sets only `c.var.sandbox`, so reading `c.var.user` threw on every
  // request the CLI actually makes. It also answered a plain signed-in
  // caller, which turned a session-scoped broker into a plaintext read of
  // the org vault for anyone with a cookie — the sibling browse route
  // deliberately strips values for exactly that reason.
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
  if (!Array.isArray(references) || references.some((r) => typeof r !== "string")) {
    return c.json({ error: "references must be an array of strings" }, 400);
  }
  if (references.length > MAX_REFERENCES) {
    return c.json({ error: `at most ${MAX_REFERENCES} references per request` }, 400);
  }
  // Every bad reference, not the first: the CLI rejects the whole batch on
  // this error, and naming one of several sent the reader to debug a
  // reference that was fine.
  const unsupported = (references as string[]).filter((r) => !REFERENCE.test(r));
  if (unsupported.length > 0) {
    return c.json(
      {
        error: `not a supported secret reference: ${unsupported.join(", ")}. Use op://vault/item/field.`,
      },
      400,
    );
  }

  const ctx = { orgId: sandbox.orgId, userId: sandbox.userId };
  const resolved: Record<string, string> = {};
  for (const reference of new Set(references as string[])) {
    // Org scope first: a shared service account is the configured path. A
    // personal token answers only for the user this session runs as.
    for (const scope of ["org", "personal"] as const) {
      try {
        resolved[reference] = await onePassword.resolveReference(scope, ctx, reference);
        break;
      } catch {
        // No token for this scope, or 1Password refused this reference.
        // Neither ends the request: the next scope may answer, and a
        // reference nobody can resolve is reported by name below.
      }
    }
  }

  const resp: ResolveSandboxSecretsResponse = {
    // Base64 so a shell can extract the field without a JSON parser. See
    // `ResolveSandboxSecretsResponse`.
    resolvedBase64: Object.fromEntries(
      Object.entries(resolved).map(([reference, value]) => [
        reference,
        Buffer.from(value, "utf8").toString("base64"),
      ]),
    ),
    // Named, not thrown: the CLI decides whether a missing one is fatal, and
    // says WHICH reference failed rather than "the run failed".
    unresolved: [...new Set(references as string[])].filter((r) => !(r in resolved)),
  };
  return c.json(resp);
});
