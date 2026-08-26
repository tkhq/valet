/**
 * Which GitHub credential a content source syncs with. The whole tenancy rule
 * for repository sync, in one function, because picking the wrong credential
 * here is a privilege escalation.
 *
 * | owner  | credential                                   |
 * | ------ | -------------------------------------------- |
 * | user   | that user's own GitHub credential            |
 * | team   | the credential of the user who ADDED the row |
 * |        | except `skillsrc_cfg_*`: the org App        |
 * | org    | the org's GitHub App installation token     |
 * | (none) | no credential — the read is anonymous       |
 *
 * A personal source uses the owner's own credential, so its mirror can hold
 * only what that person can already read, and only they can read the mirror.
 * A team source the UI created uses the credential of the user in
 * `created_by`, under the same rule: sharing a repository they can read
 * with their team is a deliberate act, equal to pasting the file into a
 * team skill. An org source uses the App installation because only an org
 * admin can create one (`routes/skills.ts`), and installing the App is
 * itself an org-admin decision.
 *
 * A config-managed team source (`skillsrc_cfg_*`) is different. The
 * reconciler writes it from `valet.yaml` and omits `created_by` — there is
 * no adding user. Treating that NULL the way a pre-column UI row is treated
 * would read GitHub with no `Authorization` header, so a private team
 * folder would 404 on every poll. The file is an operator declaration, the
 * same act as an org config source, so those rows resolve with `auth:
 * "app"` and the same privilege as `ownerType === "org"`. A UI team source
 * (id not `skillsrc_cfg_`) still uses `created_by` and never climbs to the
 * App.
 *
 * ## The binding is re-checked at READ time, not at creation
 *
 * `createContentSource` checks team membership once, and the row then reads
 * GitHub every `SYNC_INTERVAL_MS` for as long as it exists. If the person in
 * `created_by` later leaves the team or the org, that one check would keep
 * pulling a private repository with their credential, and the source row shows
 * the OWNER, not the identity funding the read. So every sync asks again:
 *
 *   1. For a team source, is `created_by` still a member of that team?
 *   2. For a user or team source, is that person still a member of the org?
 *
 * ## Never `auth: "auto"`
 *
 * `resolveGitHubToken`'s `auto` ladder falls from a user credential through
 * the org's App installation to the org's PAT, which would let a source whose
 * owner has no GitHub connection read every repository the App is installed
 * on. Both calls below name an explicit `auth`, which the resolver honors
 * strictly.
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
 *                     example after the encryption key changed, or an org
 *                     App token mint failed. The 404 names retry.
 *   - `missing_app` — an org source or a config-managed team source has
 *                     no App installation that covers the repository.
 *                     The 404 names installing the App.
 */
import type { ContentSourceRow } from "../schema/index.js";
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

/** Org or config-team source whose App install is missing or does not
 * cover the repo. */
const MISSING_APP: SkillRepoCredential = { kind: "missing_app" };

/** Credential exists but cannot be used. The 404 names retry, not reinstall. */
const UNAVAILABLE: SkillRepoCredential = { kind: "unavailable" };

/** `resolveGitHubToken` with `auth: "app"` throws this when mint returns
 * null for the repository owner. Other `GitHubAuthError`s are mint or
 * transport faults and must not tell the reader to reinstall the App. */
function isAppNotInstalledOnOwner(err: GitHubAuthError): boolean {
  return err.message.startsWith("the GitHub App is not installed on ");
}

const CONFIG_SKILL_SOURCE_PREFIX = "skillsrc_cfg_";

/**
 * Org sources, and team sources the instance config declared, read through
 * the org App. See the file comment: a `skillsrc_cfg_*` team row has no
 * adding user, so the `created_by` path would stay anonymous.
 */
function usesOrgApp(source: SkillSourceRow): boolean {
  return (
    source.ownerType === "org" ||
    (source.ownerType === "team" && source.id.startsWith(CONFIG_SKILL_SOURCE_PREFIX))
  );
}

/**
 * The credential this source may sync with. Never throws: a sync must not fail
 * a public repository over a credential it does not need.
 *
 * `GitHubAuthError` is the resolver's way of saying "no credential is
 * available". A user or UI team source reads that as `none`. An org
 * source or a config-managed team source maps only "the GitHub App is
 * not installed on <owner>" to `missing_app`. A mint or transport fault
 * is `unavailable`, so the 404 names retry rather than reinstall. Any
 * OTHER failure is a fault in reading the credential — a wrong
 * `ENCRYPTION_KEY` makes `decryptSecret` throw a raw crypto error
 * through `CredentialStore.get`, for instance. That fault is reported
 * as `unavailable` and logged here, because letting it propagate would
 * fail the whole sync and write the crypto error onto
 * `skill_sources.last_error`, where it names no corrective action.
 *
 * A membership query that throws lands in the same catch, which is the safe
 * direction: an unconfirmed membership must not hand out a token.
 */
export async function resolveContentSourceCredential(
  deps: GitHubTokenDeps,
  source: ContentSourceRow,
): Promise<SkillRepoCredential> {
  try {
    if (usesOrgApp(source)) {
      const owner = ownerOf(source.repoFullName);
      // A row whose repository name carries no `/` cannot name an
      // installation. `parseRepoInput` rejects that shape on the way in.
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

    // user and team both resolve ONE person's own credential, and differ only
    // in which column names that person. Reading `created_by` for both would
    // work until a row predates that column, which is the case handled below.
    const userId = source.ownerType === "user" ? source.ownerId : source.createdBy;
    // A team source added before `created_by` existed names nobody, and a
    // sync must not guess. It reads anonymously.
    if (userId === null || userId.length === 0) return ANONYMOUS;

    // The re-checks run BEFORE the token is resolved, so a departed person's
    // token is never read out of the credential store at all.
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
      if (!usesOrgApp(source)) return ANONYMOUS;
      return isAppNotInstalledOnOwner(err) ? MISSING_APP : UNAVAILABLE;
    }
    // Only the message, and only to the server log. The source row is shown
    // to users, and an arbitrary error is not written for them to read.
    console.error(
      `content sync ${source.id}: cannot read the GitHub credential:`,
      err instanceof Error ? err.message : String(err),
    );
    return UNAVAILABLE;
  }
}

/** The reader factory `ContentSyncService` calls once per sync. The server and
 * the integration harness both build it here, so neither holds its own copy of
 * the rule above. */
export function skillRepoReaderFactory(
  deps: GitHubTokenDeps,
  opts: { apiUrl?: string } = {},
): (source: ContentSourceRow) => Promise<SkillRepoReader> {
  return async (source) => {
    const credential = await resolveContentSourceCredential(deps, source);
    return new GitHubSkillRepoReader({ apiUrl: opts.apiUrl, credential });
  };
}
