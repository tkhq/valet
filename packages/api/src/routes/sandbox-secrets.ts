/**
 * The secret broker a sandbox CLI talks to.
 *
 * The shape is Infisical's: an agent never reads a secret, it says where one
 * should be delivered. `valet secrets run --env GITHUB_TOKEN=op://… -- cmd`
 * resolves the reference here, and the CLI puts the value in the child
 * process's environment. The value crosses this boundary once, into a process
 * the model does not read, and never enters the transcript.
 *
 * No bespoke auth: the ladder in `middleware/auth.ts` already accepts the
 * `x-valet-sandbox` token every sandbox is started with, and derives the
 * principal from the token rather than from headers. So the credential is
 * agent-scoped and time-boxed by construction — a leaked token is worth its
 * remaining lifetime, for one session's principal, and nothing else.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { ResolveSandboxSecretsResponse } from "../wire/types.js";

export const sandboxSecretsRouter = new Hono<AppEnv>();

/** References this broker resolves. Only 1Password today; the runner's
 * `SecretsProvider` seam is where a second one would land. */
const REFERENCE = /^op:\/\/[^\s]+$/;

/** One `run` injecting hundreds of secrets is a mistake, and each reference
 * costs a round trip. */
const MAX_REFERENCES = 25;

sandboxSecretsRouter.post("/resolve", async (c) => {
  const { onePassword } = c.var.providers;
  const user = c.var.user;

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
  const unsupported = (references as string[]).find((r) => !REFERENCE.test(r));
  if (unsupported) {
    return c.json({ error: `not a supported secret reference: ${unsupported}` }, 400);
  }

  const ctx = { orgId: user.orgId, userId: user.id };
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
    resolved,
    // Named, not thrown: the CLI decides whether a missing one is fatal, and
    // says WHICH reference failed rather than "the run failed".
    unresolved: [...new Set(references as string[])].filter((r) => !(r in resolved)),
  };
  return c.json(resp);
});
