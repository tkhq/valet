/**
 * `POST /api/sandbox/pull-request-requirement`: the org rule for pull
 * requests, for the sandbox `gh` shim (`engine/git-credential-helper.ts`).
 * The shim asks before `gh pr create` and checks the branch's commits with
 * `gh api` itself (`services/signed-pull-requests.ts`).
 *
 * Sandbox-token only, like `POST /api/sandbox/git-credential`: the principal
 * comes from the verified `x-valet-sandbox` header. Answers 204 when the org
 * has no rule, and 200 `text/plain` with the instruction when it does. Plain
 * text keeps the shim free of a JSON parser.
 *
 * A workflow session, or a session a team or the org owns, has no person to
 * sign its commits, so the instruction says to report the branch instead.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import { publicUrlFromEnv } from "../channels/host.js";
import { agentSessions } from "../schema/index.js";
import { signedPullRequestRequirement } from "../services/signed-pull-requests.js";
import { workflowSessionOwner } from "../workflows/session-owner.js";

export const sandboxPullRequestsRouter = new Hono<AppEnv>();

sandboxPullRequestsRouter.post("/pull-request-requirement", async (c) => {
  const sandbox = c.var.sandbox;
  if (!sandbox) return c.json({ error: "sandbox principal required" }, 401);
  const { db } = c.var.providers;

  const workflowOwner = await workflowSessionOwner(db, sandbox.sessionId, sandbox.orgId);
  let userId = sandbox.userId;
  if (workflowOwner === undefined) {
    const [session] = await db.select({ ownerType: agentSessions.ownerType, ownerId: agentSessions.ownerId })
      .from(agentSessions).where(eq(agentSessions.id, sandbox.sessionId)).limit(1);
    if (session && (session.ownerType === "team" || session.ownerType === "org")) userId = `${session.ownerType}:${session.ownerId}`;
  }
  const requirement = await signedPullRequestRequirement(db, publicUrlFromEnv(process.env))({
    userId,
    orgId: sandbox.orgId,
    ...(workflowOwner !== undefined ? { unattended: true } : {}),
  });
  if (requirement === undefined) return c.body(null, 204);
  return c.text(requirement);
});
