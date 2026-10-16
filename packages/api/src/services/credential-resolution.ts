/**
 * Owner-precedence contract (1Password credential provider plan, Task 6):
 * ONE shared read implementation for "user row shadows org row" (ALL
 * credential kinds, not just 1Password references) plus 1Password reference
 * resolution built into the read. Consumed by all three credential readers
 * that used to duplicate or omit pieces of this logic:
 *
 *   - the session resolver (`engine/host.ts`'s `buildCredentialResolver`,
 *     non-github branch) via `resolveUserCredentialRead`
 *   - the workflow tool-node action invoker (`plugins/action-invoker.ts`)
 *     via `resolveUserCredentialRead` (user-owned runs) or
 *     `resolveOrgCredentialRead` (org-owned runs)
 *   - `ChannelHost`'s bot-token read (`channels/host.ts`) via
 *     `resolveOrgCredentialRead`
 *
 * The escalation is DECLARED, not assumed. Every caller states an
 * `OrgFallback`, and the default a caller derives from the plugin registry
 * (`orgFallbackPolicy`) reaches an org row only for a service some plugin
 * declared org-provided, or when the org row is an admin's 1Password
 * pointer. A plain org row stays invisible to a member's session.
 *
 * That line is deliberate. Org-ownership is an addressing detail for
 * machinery, not a statement of sharing: an org-owned `linear` row carries
 * `metadata.webhookSecret` (`plugins/http-linear-connection.ts`), which the inbound
 * webhook verifies HMACs with, so handing whole org rows to member sessions
 * would hand out that secret. Reads are not free either —
 * `OAuthRefreshingCredentialStore.get` refreshes and writes back under the
 * owner it read, so an org read is an org write.
 *
 * This replaces the `service === "slack"` literal the session path used to
 * carry: `plugin-slack` declares `requires.orgCredential`, so the policy
 * covers it without naming it.
 */
import { credentialSecret, type CredentialStore, type StoredCredential, type ValetPlugin } from "@valet/engine";
import { CredentialReferenceBrokenError } from "../plugins/team-credential-store.js";
import { findCredentialDeclaration } from "./integration-availability.js";
import { LINEAR_CLIENT_CREDENTIALS_GRANT } from "./linear-app.js";
import {
  ONEPASSWORD_SERVICE,
  OnePasswordAuthError,
  onePasswordMeta,
  type OnePasswordService,
  OnePasswordScope,
} from "./onepassword.js";

/** Internal services that must never surface as ordinary session/workflow
 * credentials. `onepassword` rows are the service-account tokens themselves;
 * `github_app` holds the GitHub App PEM/secrets; `llm:*` rows are org LLM
 * provider keys resolved only through the model/OpenAI probe paths.
 *
 * Exported so the write path can refuse the same set: every consumer of these
 * services reads its row RAW, so a 1Password reference stored under one would
 * verify at save time and then be read as an empty credential forever. */
export function isDeniedCredentialService(service: string): boolean {
  return service === ONEPASSWORD_SERVICE || service === "github_app" || service === "linear_app" || service.startsWith("llm:");
}

export interface CredentialReadDeps {
  credentials: CredentialStore;
  onePassword?: OnePasswordService;
  /** The members sharing their own account for a service with a team, oldest
   * first (`credential-shares.ts#membersSharing`). Absent reads no shares. */
  shares?: (teamId: string, service: string) => Promise<string[]>;
}

export interface CredentialReadCtx {
  orgId: string;
  userId?: string;
  /** Which 1Password token scopes a vault lookup may consult. Absent means
   * both, which is right only for a read made on behalf of the user
   * themselves. Session-bound readers pass `onePasswordScopesFor(ownerType)`. */
  scopes?: readonly OnePasswordScope[];
}

/**
 * The 1Password scopes a session's reads may consult, from who owns it.
 *
 * The user id on a session is the actor frozen onto it at creation, not
 * whoever is prompting it now. A team- or org-owned session can be prompted
 * by anyone in that group, so consulting the frozen actor's PERSONAL vault
 * would hand their private items to their colleagues. Only a user-owned
 * session reaches the personal scope; an unknown owner gets the org scope
 * alone, which is the safe side of the mistake.
 */
export function onePasswordScopesFor(ownerType: string | undefined, teamId?: string): readonly OnePasswordScope[] {
  if (ownerType === "team" && teamId) return ["team", "org"];
  return ownerType === "user" ? ["org", "personal"] : ["org"];
}

/** A read made as a specific user: `orgId`, `userId`, and the scopes the
 * session's owner allows (`onePasswordScopesFor`). Required, so no caller can
 * reach the personal vault by forgetting to decide. */
export type UserReadCtx = Required<Pick<CredentialReadCtx, "orgId" | "userId" | "scopes">> & { teamId?: string };

/**
 * Resolves a raw store row through 1Password when applicable. `onePassword`
 * absent, or the row carries no `metadata.onepassword` -> the row is
 * returned UNCHANGED (same object reference, no clone) so a non-1Password
 * deployment/row is byte-identical to a plain `CredentialStore.get` read.
 * `OnePasswordAuthError` from `resolveCredential` propagates unchanged.
 *
 * This is the one door every stored row passes through, so the owner rule
 * holds here for the user row, the org row, and the channel host alike: a
 * caller cannot reach a personal vault through a row it could not reach
 * through the vault lookup. `excluded` is the reader's choice for a row
 * whose `tokenScope` its scopes leave out. A user read skips it, so the read
 * falls through to the org row and the vaults as if the row were absent. An
 * org read refuses it with the typed `OnePasswordAuthError`, the fail-loud
 * contract `resolveOrgCredentialRead` documents.
 *
 * The org read refuses on the scopes alone rather than trusting the write
 * path. `PUT /api/credentials/:service` rejects a personal `tokenScope` on an
 * org-scoped row today, and it is the only writer of `metadata.onepassword`,
 * but a caller that supplies a `userId` (an org-owned workflow run does)
 * would otherwise resolve such a row through THAT person's personal token.
 * The rule belongs where every row passes, not only where rows are written.
 */
async function resolveRow(
  deps: CredentialReadDeps,
  row: StoredCredential | null,
  ctx: UserReadCtx,
  excluded: "skip" | "resolve",
): Promise<StoredCredential | null> {
  if (!row) return null;
  const meta = onePasswordMeta(row);
  if (!deps.onePassword || !meta) return row;
  if (!ctx.scopes.includes(meta.tokenScope)) {
    if (excluded === "skip") return null;
    throw new OnePasswordAuthError(
      `This credential reads a ${meta.tokenScope} 1Password token, which this session may not use.`,
      "scope",
    );
  }
  return deps.onePassword.resolveCredential(row, ctx);
}

/**
 * How far a user-owner read may escalate when the user has no row of their own.
 *
 * `"org-provided"` — a plugin declared the service org-provided
 * (`requires.orgCredential`), so the org row IS the configured credential for
 * everybody. `"reference-only"` — the org row is reachable only when it is an
 * admin's 1Password pointer, which is a deliberate act of sharing. `"none"` —
 * no escalation, for an incidental read of some other service.
 */
export type OrgFallback = "none" | "reference-only" | "org-provided";

/**
 * The escalation policy for one service, read from the plugin declarations.
 * An absent registry yields `"reference-only"`, so a caller that cannot see
 * the declarations escalates less rather than more.
 */
export function orgFallbackPolicy(plugins: ValetPlugin[] | undefined, service: string): OrgFallback {
  return findCredentialDeclaration(plugins ?? [], service)?.requires?.orgCredential === true
    ? "org-provided"
    : "reference-only";
}

/**
 * User-then-org precedence read for every credential kind, plus 1Password
 * reference resolution. `ctx.userId` is required: this is the "acting as a
 * specific user" half of the contract, and a personal-scope reference on
 * either row resolves against that user.
 *
 * The user row wins outright when present, reference or plain, and the org
 * row is not read. On a user-row miss the org row is consulted only as far
 * as `orgFallback` allows, and the vaults only when the caller has a row
 * for nothing.
 */
export async function resolveUserCredentialRead(
  deps: CredentialReadDeps,
  ctx: UserReadCtx,
  service: string,
  orgFallback: OrgFallback,
): Promise<StoredCredential | null> {
  if (isDeniedCredentialService(service)) return null;
  const userRow = await deps.credentials.get({ type: "user", id: ctx.userId }, service);
  const fromUser = await resolveRow(deps, userRow, ctx, "skip");
  if (fromUser) return fromUser;
  if (orgFallback === "none") return null;
  // Skip the org read entirely when only a reference could qualify and no
  // 1Password service is wired. `CredentialStore.get` is NOT side-effect free:
  // `OAuthRefreshingCredentialStore` refreshes on read and writes the result
  // back under the owner it read, so an org read is an org write.
  if (orgFallback === "reference-only" && !deps.onePassword) return null;
  // A plain org row stays invisible. An org-owned `linear` row carries
  // `metadata.webhookSecret` (`plugins/http-linear-connection.ts`), so returning the
  // whole row to every member's session would hand out the webhook HMAC.
  // With no row to answer, the read falls through to the vault lookup.
  const fromOrg = await readOrgRow(deps, ctx, service, "skip", (row) => orgFallback === "org-provided" || !!onePasswordMeta(row));
  return fromOrg === ABSENT ? lookupInOnePassword(deps, ctx, service) : fromOrg;
}

/**
 * The secret for `service` from 1Password, when Valet holds no row for it.
 *
 * This is the point of connecting a token: an agent or subagent asking for a
 * credential nobody configured gets the one already sitting in the vaults,
 * rather than a null and a hidden tool. Nothing is written — the value is
 * read at the moment it is needed, the same as a stored reference.
 *
 * The match is on the item title, so whoever can name items in an accessible
 * vault decides what an integration authenticates as. That is why the vaults
 * a service account may read are the security boundary here, and why the
 * token should be scoped to vaults chosen for this.
 *
 * Exported for `workflows/team-service-readiness.ts`, which has to give the
 * same answer a team run gets when it reaches this lookup.
 */
export async function lookupInOnePassword(
  deps: CredentialReadDeps,
  ctx: UserReadCtx,
  service: string,
): Promise<StoredCredential | null> {
  if (!deps.onePassword) return null;
  // Team is authoritative when configured; only no_token permits fallback.
  // User sessions retain org/personal ordering. Explicit rows bypass discovery.
  for (const scope of ctx.scopes) {
    try {
      const secret = await deps.onePassword.findCredentialForService(scope, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        teamId: ctx.teamId,
      }, service);
      if (secret) return { type: "api_key", apiKey: secret };
      if (scope === "team") return null;
    } catch (err) {
      if (err instanceof OnePasswordAuthError && err.kind === "ambiguous") throw err;
      // A configured team token must not silently substitute org credentials.
      if (scope === "team" && !(err instanceof OnePasswordAuthError && err.kind === "no_token")) throw err;
      // No token for this scope, or 1Password refused. Neither is an error
      // for a credential read: it just means this scope has no answer.
    }
  }
  return null;
}

/**
 * Org-row-only read (no user row is ever consulted), plus 1Password
 * reference resolution — for readers with no live user in scope (ChannelHost
 * bot tokens, org-owned workflow runs). Without `ctx.userId`, a
 * personal-tokenScope reference on the org row resolves against
 * `userId: ""`, which `OnePasswordService.resolveCredential` turns into the
 * typed `OnePasswordAuthError` (no personal token owner to look up) rather
 * than a silent null — callers must handle that error explicitly.
 *
 * An app credential row comes back as a bare token (`readOrgRow`): an
 * org-owned session or workflow run gets `{ type, accessToken }` and none of
 * the row's metadata, which holds the inbound webhook secret.
 */
export async function resolveOrgCredentialRead(
  deps: CredentialReadDeps,
  ctx: CredentialReadCtx,
  service: string,
): Promise<StoredCredential | null> {
  if (isDeniedCredentialService(service)) return null;
  const fromOrg = await readOrgRow(deps, { orgId: ctx.orgId, userId: ctx.userId ?? "", scopes: ctx.scopes ?? ["org"] }, service, "resolve");
  return fromOrg === ABSENT ? null : fromOrg;
}

/** `readOrgRow`'s answer when no org row exists, or the caller's `admit`
 * turned the row away. It differs from `null`, a row that resolved to
 * nothing, because the user read goes on to the vaults only on this one. */
const ABSENT = Symbol("absent");

/**
 * The one door every org-row read passes through: the user read's org
 * fallback, the team read's org-provided step, the org-owned read, and the
 * app credential read. It reads the row, resolves a 1Password pointer on it
 * (`resolveRow`), and then reduces an app credential row (INV-P1):
 *
 * - For a service whose org row is meant to hold the app credential
 *   (`APP_CREDENTIAL_ROWS`), the caller gets a bare token.
 * - For any other service, an app credential row reads as `null`
 *   (native credential policy, Part D item 2).
 *
 * No caller can hand an app row's metadata to an action, because no caller
 * reads an org row any other way. `admit` sees the raw row before any
 * resolution, for a caller that accepts only some rows.
 */
async function readOrgRow(
  deps: CredentialReadDeps,
  ctx: UserReadCtx,
  service: string,
  excluded: "skip" | "resolve",
  admit: (row: StoredCredential) => boolean = () => true,
): Promise<StoredCredential | null | typeof ABSENT> {
  const row = await deps.credentials.get({ type: "org", id: ctx.orgId }, service);
  if (!row || !admit(row)) return ABSENT;
  const resolved = await resolveRow(deps, row, ctx, excluded);
  if (!resolved || !isAppCredentialRow(resolved)) return resolved;
  return APP_CREDENTIAL_ROW_SERVICES.has(service) ? bareAppToken(resolved) : null;
}

/**
 * An org row that holds an app credential: a token the provider minted for
 * the app itself (`grant: client_credentials`), not a person's connection.
 * Today that is the org `linear` row (`plugins/http-linear-connection.ts`).
 */
function isAppCredentialRow(row: StoredCredential): boolean {
  return row.metadata?.grant === LINEAR_CLIENT_CREDENTIALS_GRANT;
}

/**
 * The app credential an action receives: the access token and nothing else
 * (INV-P1). The row's metadata carries the inbound webhook HMAC secret, the
 * workspace ID, and the connection ID, which no action needs. The store
 * still reads, and renews, the full row (`LinearAppTokenStore`); only the
 * value handed out is reduced. A row with no token reads as absent.
 *
 * A top-level `expiresAt` stays: it is not a secret, and the engine hands
 * it to actions (`Session.credentialProvider`), which may use it to decide
 * when a token is stale. The Linear row keeps its expiry in metadata
 * (`tokenExpiresAt`), so its bare token carries none.
 */
function bareAppToken(row: StoredCredential): StoredCredential | null {
  const accessToken = credentialSecret(row);
  if (!accessToken) return null;
  return typeof row.expiresAt === "number" ? { type: row.type, accessToken, expiresAt: row.expiresAt } : { type: row.type, accessToken };
}

/**
 * The app credential services an org row answers, mapped to the service of
 * that row. `github:installation` is minted from the GitHub App
 * (`services/github-tokens.ts`), and the Slack app credential is the org
 * `slack` row itself, read through the org-provided policy, so neither is
 * listed here.
 */
const APP_CREDENTIAL_ROWS: ReadonlyMap<string, string> = new Map([["linear:app", "linear"]]);
const APP_CREDENTIAL_ROW_SERVICES: ReadonlySet<string> = new Set(APP_CREDENTIAL_ROWS.values());

/** Whether `service` is an app credential service an org row answers
 * (`resolveAppCredentialRead`). */
export function isAppCredentialRowService(service: string): boolean {
  return APP_CREDENTIAL_ROWS.has(service);
}

/**
 * Whether a native plugin names `service` as its app credential service
 * (`ValetPlugin.appCredentialService`). This is the class check of native
 * credential policy Part B: a service no native plugin names never resolves
 * to an app token (INV-P2). Config-declared MCP servers are never native
 * (`plugins/config-mcp.ts`).
 */
export function isNativeAppCredentialService(plugins: readonly ValetPlugin[] | undefined, service: string): boolean {
  return (plugins ?? []).some((plugin) => plugin.native === true && plugin.appCredentialService === service);
}

/**
 * The app credential service of the native plugin that declares `service`'s
 * credential (`linear` → `linear:app`), or `undefined` when that plugin is
 * not native or no plugin declares the service.
 */
export function nativeAppCredentialServiceFor(plugins: readonly ValetPlugin[] | undefined, service: string): string | undefined {
  for (const plugin of plugins ?? []) {
    if (plugin.native !== true) continue;
    if ((plugin.credentials ?? []).some((decl) => (decl.service ?? plugin.name) === service)) return plugin.appCredentialService;
  }
  return undefined;
}

/**
 * The app token for an app credential service that an org row answers:
 * `linear:app` reads the org `linear` row and hands out its token only when
 * that row is the app connection (`grant: client_credentials`). The answer
 * is the same for every session owner, because the app identity belongs to
 * the org. `null` when no native plugin names the service, when the service
 * is not row-backed (`github:installation`, `slack`), or when the row is
 * absent or not an app credential.
 */
export async function resolveAppCredentialRead(
  deps: CredentialReadDeps,
  ctx: { orgId: string },
  service: string,
  plugins: readonly ValetPlugin[] | undefined,
): Promise<StoredCredential | null> {
  const rowService = APP_CREDENTIAL_ROWS.get(service);
  if (!rowService || !isNativeAppCredentialService(plugins, service)) return null;
  // The app row is never a 1Password pointer, so the org scope alone is
  // enough, and no person's vault is in reach.
  const fromOrg = await readOrgRow(deps, { orgId: ctx.orgId, userId: "", scopes: ["org"] }, rowService, "resolve", isAppCredentialRow);
  return fromOrg === ABSENT ? null : fromOrg;
}

/** Who a team read acts for, and which members it may borrow an account
 * from. `userId` is the acting member: their own share is used first. A
 * share of anyone else is used only when `mayBorrow` says that member
 * approved (`credential-borrow.ts`). */
export interface TeamReadCtx {
  orgId: string;
  teamId: string;
  userId?: string;
  scopes?: readonly OnePasswordScope[];
  mayBorrow?: (memberId: string) => Promise<boolean>;
  /**
   * Whether a tier after this read will answer: the native integration's app
   * token (native credential policy, Part B). When it resolves true, a read
   * that ends on a dead team connection or a broken share returns `null`, so
   * the caller goes on to that tier instead of the dead row or the error.
   * It is called only on those two paths.
   */
  laterTier?: () => Promise<boolean>;
}

/**
 * The credential a team action uses, in this order:
 *
 * 1. The acting member's own share. Using your own account needs no approval.
 * 2. The team's own connection, plus 1Password resolution on that row. It is
 *    meant for the team, so it needs no approval either.
 * 3. The org row, only when `orgFallback` is `"org-provided"` (a plugin
 *    declared the service as the org bot), then the team's 1Password vaults.
 *    `"none"` skips both, the same escalation line the user read draws.
 * 4. Another member's share, oldest first, when `mayBorrow` allows it.
 *
 * When nothing up to step 3 answers and another member's share would,
 * `approvalFrom` names that member: the action needs their approval first.
 * With nothing at all, a dead team connection or a broken share is the last
 * answer, unless `laterTier` says a later tier will answer.
 * A personal-tokenScope 1Password pointer on a team row fails closed through
 * `resolveRow` (`excluded: "resolve"`).
 */
export async function readTeamCredential(
  deps: CredentialReadDeps,
  ctx: TeamReadCtx,
  service: string,
  orgFallback: OrgFallback,
): Promise<{ credential: StoredCredential | null; approvalFrom?: string }> {
  if (isDeniedCredentialService(service)) return { credential: null };
  const scopes = (ctx.scopes ?? onePasswordScopesFor("team", ctx.teamId)).filter((scope) => scope !== "personal");
  const readCtx = { orgId: ctx.orgId, teamId: ctx.teamId, userId: ctx.userId ?? "", scopes };
  const sharers = deps.shares ? await deps.shares(ctx.teamId, service) : [];
  let brokenShare = false;
  const fromShare = async (memberId: string) => {
    const row = await deps.credentials.get({ type: "user", id: memberId }, service);
    const credential = await resolveRow(deps, row, { ...readCtx, userId: memberId }, "resolve");
    if (!credential || isUnusableOAuthCredential(credential, Date.now())) {
      brokenShare = true;
      return null;
    }
    return credential;
  };

  if (ctx.userId && sharers.includes(ctx.userId)) {
    const own = await fromShare(ctx.userId);
    if (own) return { credential: own };
  }
  const teamRow = await deps.credentials.get({ type: "team", id: ctx.teamId }, service);
  const fromTeam = await resolveRow(deps, teamRow, readCtx, "resolve");
  // A dead team connection cannot answer, so the read goes on to the org row
  // and members' shares, still asking a share's member first. It stays the
  // last answer, so with nothing else the caller gets the provider's refusal.
  const deadTeam = fromTeam && isDeadConnection(fromTeam, Date.now()) ? fromTeam : null;
  if (fromTeam && !deadTeam && !isUnusableOAuthCredential(fromTeam, Date.now())) return { credential: fromTeam };
  if (orgFallback !== "none") {
    if (orgFallback === "org-provided") {
      const fromOrg = await readOrgRow(deps, readCtx, service, "resolve");
      if (fromOrg !== ABSENT && fromOrg) return { credential: fromOrg };
    }
    const fromVault = await lookupInOnePassword(deps, readCtx, service);
    if (fromVault) return { credential: fromVault };
  }
  // A member who already approved comes before asking anyone new, so an
  // approval holds even when an older sharer is listed first.
  const others = sharers.filter((memberId) => memberId !== ctx.userId);
  const approved = await Promise.all(others.map(async (memberId) => (await ctx.mayBorrow?.(memberId)) === true));
  for (const [i, memberId] of others.entries()) {
    if (!approved[i]) continue;
    const borrowed = await fromShare(memberId);
    if (borrowed) return { credential: borrowed };
  }
  for (const [i, memberId] of others.entries()) {
    // Only an account that would actually answer is worth an approval.
    if (!approved[i] && await fromShare(memberId)) return { credential: null, approvalFrom: memberId };
  }
  if ((deadTeam || brokenShare) && await ctx.laterTier?.()) return { credential: null };
  if (deadTeam) return { credential: deadTeam };
  // A share whose member left their account unusable: name the fix.
  if (brokenShare) throw new CredentialReferenceBrokenError(service);
  return { credential: null };
}

/** An expired OAuth token without a refresh token cannot answer a run.
 * Supports stored credentials and raw rows without reading their secrets. */
export function isUnusableOAuthCredential(
  row: { type: string; expiresAt?: number | null; refreshToken?: string; refreshTokenEnc?: string | null; metadata?: unknown },
  now: number,
): boolean {
  return row.type === "oauth2" && typeof row.expiresAt === "number" && row.expiresAt <= now
    && !row.refreshToken && !row.refreshTokenEnc && !isDeadConnection(row, now);
}

/**
 * A connection Valet can no longer use: the provider refused its refresh
 * token (`metadata.refreshRefused`, a 400 or 401 from the token endpoint) and
 * its access token is past expiry. A temporary refresh failure does not count.
 * The refreshing store retries on every read and clears the stamp when a
 * refresh works. Takes a stored credential or a raw `credentials` row.
 */
export function isDeadConnection(row: { type: string; expiresAt?: number | null; metadata?: unknown }, now: number): boolean {
  const metadata = row.metadata;
  const refused = typeof metadata === "object" && metadata !== null && "refreshRefused" in metadata && metadata.refreshRefused === true;
  return row.type === "oauth2" && refused && typeof row.expiresAt === "number" && row.expiresAt <= now;
}

/** `readTeamCredential`'s credential: a team action's read. */
export async function resolveTeamCredentialRead(
  deps: CredentialReadDeps,
  ctx: TeamReadCtx,
  service: string,
  orgFallback: OrgFallback,
): Promise<StoredCredential | null> {
  return (await readTeamCredential(deps, ctx, service, orgFallback)).credential;
}
