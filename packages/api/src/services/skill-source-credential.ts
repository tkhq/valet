/**
 * Which GitHub credential a skill source syncs with.
 *
 * This is the whole tenancy rule for skill sync, in one function, because
 * picking the wrong credential here is a privilege escalation and a reviewer
 * must be able to check the rule without reading the sweep.
 *
 * ## The rule
 *
 * | owner  | credential                                  |
 * | ------ | ------------------------------------------- |
 * | user   | that user's own GitHub credential           |
 * | team   | the credential of the user who ADDED the row |
 * | org    | the org's GitHub App installation token     |
 * | (none) | no credential — the read is anonymous       |
 *
 * A personal source uses the owner's own credential, so its mirror can hold
 * only what that person can already read, and only they can read the mirror.
 * A team source uses the credential of the user in `created_by`, under the
 * same rule: sharing a repository they can read with their team is a
 * deliberate act, equal to pasting the file into a team skill. An org source
 * uses the App installation because only an org admin can create one
 * (`routes/skills.ts`), and installing the App is itself an org-admin
 * decision.
 *
 * ## The binding is re-checked at READ time, not at creation
 *
 * `createSkillSource` checks team membership before it writes the row. That
 * check alone is not enough, because the row then reads GitHub every
 * `SYNC_INTERVAL_MS` for as long as it exists, and any remaining team member
 * can force a read with "Sync now". If the person named in `created_by`
 * later leaves the team or the org, a creation-time check would keep pulling
 * a private repository with their credential, into skill rows the team still
 * reads. Nothing would show it: the source row shows the OWNER, not the
 * identity funding the read.
 *
 * So `resolveSkillSourceCredential` asks the same questions again on every
 * sync, matching `isTeamMember`'s stated contract that "a member removed
 * from a team must lose access to its resources on their very next request":
 *
 *   1. For a team source, is `created_by` still a member of that team?
 *   2. For a user or team source, is that person still a member of the org?
 *
 * `removeMember`, org removal, and the Keycloak de-provision sweep all
 * delete only a membership row, so these two questions are what they change.
 *
 * ## Never `auth: "auto"`
 *
 * `resolveGitHubToken`'s `auto` ladder falls from a user credential through
 * the org's App installation to the org's PAT (`services/github-tokens.ts`).
 * On this path that would let a source whose owner has no GitHub connection
 * read through the org's App, which reaches every repository the App is
 * installed on. So both calls below name an explicit `auth`, which
 * `resolveGitHubToken` honors strictly: `"user"` never reaches an
 * installation token or the org PAT, and `"app"` never reaches a user
 * credential.
 *
 * ## Fails to anonymous, never up
 *
 * Every failure here returns a tokenless credential, and the sync then reads
 * with no `Authorization` header at all — which is how every public
 * repository worked before this module existed. A source whose creator
 * disconnects GitHub, leaves the team, or leaves the org drops to anonymous
 * and its 404 names what to do. It does not climb to the App to keep
 * working, and a public repository does not stop syncing.
 *
 * The tokenless results differ so the 404 can:
 *
 *   - `none`        — there is no credential to use.
 *   - `unavailable` — a credential exists but the server cannot read it, for
 *                     example after the encryption key changed.
 *   - `missing_app` — an org source has no App installation that covers the
 *                     repository. The 404 names installing the App.
 */
import type { SkillSourceRow } from "../schema/index.js";
import {
  GitHubAuthError,
  resolveGitHubToken,
  type GitHubTokenDeps,
} from "./github-tokens.js";
import { isOrgMember } from "./org.js";
import { ownerOf, repoOf } from "./session-github-token.js";
import { isTeamMember } from "./teams.js";
import {
  GitHubSkillRepoReader,
  type SkillRepoCredential,
  type SkillRepoReader,
} from "./skill-repo-reader.js";

/** No credential to use. The read is anonymous. */
const ANONYMOUS: SkillRepoCredential = { kind: "none" };

/** Org source whose App install is missing or does not cover the repo. */
const MISSING_APP: SkillRepoCredential = { kind: "missing_app" };

/**
 * The credential this source may sync with. Never throws: a sync must not
 * fail a public repository over a credential it does not need.
 *
 * `GitHubAuthError` is the resolver's way of saying "no credential is
 * available", so it reads as `none`. Any OTHER failure is a fault in reading
 * the credential — a wrong `ENCRYPTION_KEY` makes `decryptSecret` throw a
 * raw crypto error through `CredentialStore.get`, for instance. That fault
 * is reported as `unavailable` and logged here, because letting it propagate
 * would fail the whole sync and write the crypto error onto
 * `skill_sources.last_error`, where it names no corrective action.
 *
 * A membership query that throws lands in the same catch, which is the safe
 * direction: an unconfirmed membership must not hand out a token.
 */
export async function resolveSkillSourceCredential(
  deps: GitHubTokenDeps,
  source: SkillSourceRow,
): Promise<SkillRepoCredential> {
  try {
    if (source.ownerType === "org") {
      const owner = ownerOf(source.repoFullName);
      // A row whose repository name carries no `/` cannot name an
      // installation. `parseRepoInput` rejects that shape on the way in, so
      // this only guards a hand-edited row.
      if (owner.length === 0) return ANONYMOUS;
      const resolved = await resolveGitHubToken(deps, {
        orgId: source.orgId,
        purpose: "api",
        auth: "app",
        repo: { owner, name: repoOf(source.repoFullName) },
      });
      return resolved.token === null
        ? MISSING_APP
        : { kind: "installation", token: resolved.token };
    }

    // user and team both resolve ONE person's own credential. They differ
    // only in which column names that person.
    //
    // For a user source the OWNER is the person, so `owner_id` names them
    // and `created_by` would say the same thing. For a team source the owner
    // is the team, so `owner_id` names no person at all and only
    // `created_by` does. Reading `created_by` for both would work today and
    // break the moment a row predates that column, which is exactly the
    // case handled below.
    const userId = source.ownerType === "user" ? source.ownerId : source.createdBy;
    // A team source added before `created_by` existed names nobody, and a
    // sync must not guess. It reads anonymously.
    if (userId === null || userId.length === 0) return ANONYMOUS;

    // The re-checks. See "The binding is re-checked at READ time" above.
    // They run BEFORE the token is resolved, so a departed person's token is
    // never even read out of the credential store.
    if (source.ownerType === "team" && !(await isTeamMember(deps.db, source.ownerId, userId))) {
      return ANONYMOUS;
    }
    if (!(await isOrgMember(deps.db, source.orgId, userId))) return ANONYMOUS;

    const resolved = await resolveGitHubToken(deps, {
      orgId: source.orgId,
      userId,
      purpose: "api",
      auth: "user",
    });
    if (resolved.token === null) return ANONYMOUS;
    const ownerScope = source.ownerType === "user" ? "user" : "team";
    return resolved.login === undefined
      ? { kind: "user", token: resolved.token, ownerScope }
      : { kind: "user", token: resolved.token, ownerScope, login: resolved.login };
  } catch (err) {
    if (err instanceof GitHubAuthError) {
      return source.ownerType === "org" ? MISSING_APP : ANONYMOUS;
    }
    // Only the message, and only to the server log. The source row is shown
    // to users, and an arbitrary error is not written for them to read.
    console.error(
      `skill sync ${source.id}: cannot read the GitHub credential:`,
      err instanceof Error ? err.message : String(err),
    );
    return { kind: "unavailable" };
  }
}

/**
 * The reader factory `SkillSyncService` calls once per sync. Both the server
 * (`providers/node.ts`) and the integration harness build it from here, so
 * neither can hold its own copy of the rule above.
 */
export function skillRepoReaderFactory(
  deps: GitHubTokenDeps,
  opts: { apiUrl?: string } = {},
): (source: SkillSourceRow) => Promise<SkillRepoReader> {
  return async (source) => {
    const credential = await resolveSkillSourceCredential(deps, source);
    return new GitHubSkillRepoReader({ apiUrl: opts.apiUrl, credential });
  };
}
