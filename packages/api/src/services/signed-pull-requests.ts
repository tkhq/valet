/**
 * Signed pull requests: an org admin can require that Valet opens a pull
 * request only when GitHub shows every commit on its branch as Verified
 * (`orgs.require_signed_pull_requests`).
 *
 * Two places check the rule before a pull request opens:
 *
 * - `github.create_pull_request` reads it through
 *   `ToolContext.pullRequestRequirement` and compares the branch on GitHub.
 * - The sandbox `gh` shim asks `POST /api/sandbox/pull-request-requirement`
 *   before `gh pr create` and compares the branch with `gh api`.
 *
 * Both are guardrails for the agent, not a boundary: the sandbox holds a
 * GitHub token, so a direct API call can still open a pull request. A GitHub
 * ruleset that requires signed commits is the boundary GitHub enforces.
 *
 * The text returned here is the instruction the model reads in the refusal.
 * It depends on who runs the turn and whether that person set up signing.
 */
import { eq } from "drizzle-orm";
import { loadTurnkeyConfig } from "@valet/plugin-turnkey/config";
import { COLLECTIONS, DEFAULT_KEY, PLUGIN_NAME, type EnrollmentDoc } from "@valet/plugin-turnkey/store";
import type { AppQueryable } from "../lib/drizzle.js";
import { orgs } from "../schema/index.js";
import { pluginStore } from "./plugin-store.js";

/** Who runs the turn. `GitPushTurn` from the engine has this shape. */
export interface PullRequestTurn {
  userId: string;
  orgId: string;
  externalSender?: boolean;
  unattended?: boolean;
}

export const SIGNED_PULL_REQUESTS_RULE =
  "This organization requires signed commits for pull requests: GitHub must show every commit on the branch as Verified.";

export async function requiresSignedPullRequests(db: AppQueryable, orgId: string): Promise<boolean> {
  const [row] = await db.select({ required: orgs.requireSignedPullRequests }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  return row?.required === true;
}

/** What the model does next when a commit on the branch is not Verified. */
export async function signedPullRequestNextStep(
  db: AppQueryable,
  turn: PullRequestTurn,
  publicUrl: string | undefined,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  if (turn.unattended || turn.externalSender || /^(team|org):/.test(turn.userId)) {
    return "No person can sign commits for this run. Do not open the pull request. Report the pushed branch instead.";
  }
  if (!loadTurnkeyConfig(env)) {
    return "Commit signing is not configured for this deployment. Do not open the pull request. Tell the person to ask an admin to configure commit signing.";
  }
  const enrollment = (await pluginStore(db, PLUGIN_NAME).user(turn.userId).get<EnrollmentDoc>(COLLECTIONS.enrollment, DEFAULT_KEY))?.doc;
  if (!enrollment?.signingKey) {
    const where = publicUrl ? `under Commit signing in Integrations: ${publicUrl.replace(/\/+$/, "")}/integrations` : "under Commit signing in Integrations";
    return `The person who asked has not set up commit signing. Do not open the pull request. Tell them to set it up ${where}, then ask again.`;
  }
  if (enrollment.mode === "session") {
    return "Sign the commits with a signing window (turnkey.request_signing_key), push them, then open the pull request again.";
  }
  return "Sign the commits with turnkey.sign_commits, push with git push --force-with-lease, then open the pull request again.";
}

/**
 * The org rule bound to a turn, for `CreateSessionOptions.pullRequestRequirement`.
 * Undefined when the org does not require signed commits.
 */
export function signedPullRequestRequirement(
  db: AppQueryable,
  publicUrl: string | undefined,
  env: Record<string, string | undefined> = process.env,
) {
  return async (turn: PullRequestTurn): Promise<string | undefined> => {
    if (!(await requiresSignedPullRequests(db, turn.orgId))) return undefined;
    return `${SIGNED_PULL_REQUESTS_RULE} ${await signedPullRequestNextStep(db, turn, publicUrl, env)}`;
  };
}
