/**
 * Auth provisioning — the admission rule and the better-auth hooks that
 * enforce it (spec: docs/specs/2026-07-14-auth-v2-design.md §Provisioning
 * & invites). Ports v1's `finalizeIdentityLogin` semantics onto
 * better-auth's verified hook points.
 */
import { createAuthMiddleware, APIError } from "better-auth/api";
import type { Account, BetterAuthOptions, User } from "better-auth";
import { eq, and } from "drizzle-orm";
import type { CredentialStore } from "@valet/engine";
import type { AppDb, AppQueryable } from "../lib/drizzle.js";
import { orgMembers, users, teams, teamMembers } from "../schema/index.js";
import { ensureOrg } from "../services/org.js";
import { readTeamClaim, reconcileIdpTeams } from "../services/team-sync.js";
import type { AuthConfig } from "./config.js";
import type { InstanceConfig } from "../config/instance-config.js";
import { acceptInvite, findValidInviteByCode, findValidInviteByEmail } from "./invites.js";

export type Admission =
  | { allowed: true; role: "admin" | "member"; inviteId?: string }
  | { allowed: false };

async function countUsers(db: AppQueryable): Promise<number> {
  const rows = await db.select({ id: users.id }).from(users);
  return rows.length;
}

function domainOf(email: string): string | undefined {
  return email.trim().toLowerCase().split("@").pop();
}

/**
 * The single admission rule, used by both the signup invite gate and the
 * OAuth/SSO creation gate. Order (first match wins):
 *   1. zero users in the db → admin (bootstraps the first operator)
 *   2. a valid invite matching by code, else by email → the invite's role
 *   3. email domain ∈ cfg.allowedEmailDomains (exact match, case-insensitive,
 *      no subdomain match) → member
 *   4. otherwise → denied
 *
 * The invite rule precedes the domain rule so a config-declared admin whose
 * email domain is also allowlisted is admitted as admin (the invite's role),
 * not silently downgraded to member. An allowlisted email WITHOUT an invite
 * still falls through to the domain rule → member.
 */
export async function evaluateAdmission(
  db: AppQueryable,
  cfg: AuthConfig,
  email: string,
  inviteCode?: string,
): Promise<Admission> {
  if ((await countUsers(db)) === 0) {
    return { allowed: true, role: "admin" };
  }

  const invite = (inviteCode && (await findValidInviteByCode(db, inviteCode))) || (await findValidInviteByEmail(db, email));
  if (invite) {
    return { allowed: true, role: invite.role, inviteId: invite.id };
  }

  const domain = domainOf(email);
  if (domain && cfg.allowedEmailDomains.includes(domain)) {
    return { allowed: true, role: "member" };
  }

  return { allowed: false };
}

/** Exact rejection copy for the invite gate — asserted byte-exact by tests/spec. */
export const INVITE_REQUIRED_MESSAGE = "an invite is required to join this deployment";

/**
 * The subset of better-auth's `GenericEndpointContext` our hooks read.
 * Deliberately narrow: the real type is a large request-plumbing object
 * (session config, adapters, cookie helpers, …) that would be painful to
 * fabricate in tests. TypeScript's contravariant parameter check accepts a
 * function typed against this narrower shape wherever the wider
 * `GenericEndpointContext | null` is expected, because every real context
 * structurally satisfies it — so hook functions below type-check as
 * `databaseHooks` entries without any cast, and tests can pass small real
 * objects like `{ path: "/callback/google" }` instead of double-casting a
 * partial `GenericEndpointContext`.
 */
export interface HookContext {
  path?: string;
  body?: Record<string, unknown> | null;
}

/**
 * The subset of the sso plugin's `provisionUser` argument the team sync
 * reads. Narrow for the same reason `HookContext` is (see above): the real
 * argument also carries the OAuth token set and the provider row, which a
 * test would have to fabricate whole. The plugin's wider argument type
 * satisfies this one structurally, so the callback type-checks as an
 * `SSOOptions["provisionUser"]` without a cast.
 *
 * `userInfo` is the provider's claims AFTER the plugin's whitelist: only
 * `id`/`email`/`emailVerified`/`name`/`image` survive, plus whatever
 * `oidcConfig.mapping.extraFields` names. The group claims reach this hook
 * because `auth/index.ts` declares them there.
 */
export interface SsoProvisionData {
  user: { id: string; email: string };
  userInfo: Record<string, unknown>;
}

export interface ProvisioningDeps {
  db: AppDb;
  cfg: AuthConfig;
  credentialStore: CredentialStore;
  instanceConfig?: InstanceConfig | null;
  /**
   * Path of the instance config file. Named in the message a group/team name
   * collision prints, so the reader knows which file to edit.
   */
  configPath?: string;
}

/** Google plugins' credential-read keys (`ActionPlugin.service`, underscored —
 * see packages/plugin-google-calendar/src/actions/actions.ts and
 * plugin-google-workspace's equivalent). Neither plugin's `name` (hyphenated,
 * used only by the connect-UI's default) is a real read-time key; a single
 * Google login doubles as connecting both integrations, so both get the token. */
const GOOGLE_CREDENTIAL_SERVICES = ["google_calendar", "google_workspace"];
const GITHUB_CREDENTIAL_SERVICE = "github";

function keyForEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isSocialPath(path: string | undefined): boolean {
  return path !== undefined && (path.startsWith("/callback/") || path === "/sign-in/social");
}

function isSsoPath(path: string | undefined): boolean {
  return path !== undefined && path.startsWith("/sso/callback/");
}

/** SSO paths never reject: an admission the rule would otherwise deny still
 * resolves to "member" (spec: "SSO paths skip the rule entirely (→ member,
 * or admin if first user)"). */
function roleFromAdmission(admission: Admission): "admin" | "member" {
  return admission.allowed ? admission.role : "member";
}

function readInviteCode(body: Record<string, unknown> | null | undefined): string | undefined {
  const code = body?.inviteCode;
  return typeof code === "string" ? code : undefined;
}

/**
 * Builds the better-auth hook set that enforces the admission rule end to
 * end: the signup invite gate (`hooks.before`), the OAuth/SSO creation gate
 * + role stamping (`databaseHooks.user.create.before`), post-create org
 * membership + invite bookkeeping (`.after`), and provider-token capture
 * into the credential store (`databaseHooks.account.create.after`).
 *
 * The fifth hook is the odd one out. `provisionUser` is an sso PLUGIN
 * option, not a member of `hooks`/`databaseHooks`, so `auth/index.ts` hands
 * it to `sso({...})` instead. It is returned from here anyway, because it
 * belongs with the provisioning rules and because every database hook above
 * fires on user CREATION only — none of them re-runs on a repeat sign-in,
 * and team sync must run on every one.
 *
 * ## Two team writers, one order, and why the order does not matter
 *
 * A first single-sign-on login runs three of these in sequence. The sso
 * plugin calls `handleOAuthUserInfo` — which runs the `databaseHooks` — and
 * only then `provisionUser`, both awaited, before it sets the session cookie
 * (`@better-auth/sso/dist/index.mjs`, both callback paths). So the order is:
 * admission (`user.create.before`), then org membership and the
 * config-declared team bind (`user.create.after`), then the identity-provider
 * team sync (`provisionUser`). Every later login runs `provisionUser` alone.
 *
 * Correctness must NOT rest on that order, because a plugin upgrade can
 * change it. It rests on the two writers touching disjoint rows: the bind
 * below reads `origin = 'config'` and the sync reads `origin = 'idp'`, and
 * the boot reconciler fails the api rather than let one name hold both. The
 * order is recorded here only because both paths call `ensureOrg`, and a
 * later edit that widens either scope would reintroduce the overlap.
 *
 * `user.create.before` and `.after` run within the same request but as
 * separate calls with no shared parameter — `admission`'s resolved invite
 * (if any) rides a module-scoped map keyed by lowercased email between
 * them. Defensive by construction: `.after` always deletes its entry (success
 * or not reached — a later signup from the same email simply overwrites a
 * stale one in `.before`), so a failed signup can never leak a stale grant.
 */
export function buildAuthHooks(deps: ProvisioningDeps): {
  beforeHook: ReturnType<typeof createAuthMiddleware>;
  databaseHooks: BetterAuthOptions["databaseHooks"];
  provisionUser: (data: SsoProvisionData) => Promise<void>;
} {
  const { db, cfg, credentialStore, instanceConfig, configPath } = deps;
  const pendingAdmissions = new Map<string, Admission>();

  const beforeHook = createAuthMiddleware(async (ctx) => {
    if (ctx.path !== "/sign-up/email") return;
    const body = (ctx.body ?? undefined) as Record<string, unknown> | undefined;
    const email = typeof body?.email === "string" ? body.email : "";
    const admission = await evaluateAdmission(db, cfg, email, readInviteCode(body));
    if (!admission.allowed) {
      throw new APIError("FORBIDDEN", { message: INVITE_REQUIRED_MESSAGE });
    }
  });

  const userCreateBefore = async (
    user: User & Record<string, unknown>,
    context: HookContext | null,
  ): Promise<{ data: (User & Record<string, unknown>) & { role: "admin" | "member" } } | false> => {
    const path = context?.path;
    let admission: Admission;

    if (isSsoPath(path)) {
      // SSO always passes regardless of admission's verdict (see roleFromAdmission).
      admission = await evaluateAdmission(db, cfg, user.email);
    } else if (isSocialPath(path)) {
      admission = await evaluateAdmission(db, cfg, user.email);
      if (!admission.allowed) return false;
    } else {
      // "/sign-up/email" (already gated by beforeHook, above) or a null/internal
      // context (trusted caller) — re-run the same rule, with the invite code
      // from this request's body if one is available, to resolve the role to
      // stamp and to hand the matched invite (if any) to `.after`.
      admission = await evaluateAdmission(db, cfg, user.email, readInviteCode(context?.body));
    }

    if (admission.allowed) {
      pendingAdmissions.set(keyForEmail(user.email), admission);
    }

    return { data: { ...user, role: roleFromAdmission(admission) } };
  };

  const userCreateAfter = async (user: User & Record<string, unknown>): Promise<void> => {
    const key = keyForEmail(user.email);
    const admission = pendingAdmissions.get(key);
    pendingAdmissions.delete(key);

    const org = await ensureOrg(db);
    const role: "admin" | "member" = user.role === "admin" ? "admin" : "member";
    await db.insert(orgMembers).values({ orgId: org.id, userId: user.id, role, createdAt: Date.now() });

    if (admission?.allowed && admission.inviteId) {
      await acceptInvite(db, admission.inviteId, user.id);
    }

    // Bind the user to any config-declared teams whose member list includes
    // this email. Team rows are resolved by name within the org — if a team
    // is missing (e.g. config edited after boot), skip silently; the next
    // boot's reconciler recreates it.
    //
    // `origin = 'config'` is part of that lookup because a team the file does
    // not own is not the file's to write. A same-named `idp` row belongs to
    // the login sync, which removes whoever the group claim omits, so binding
    // to it would add a member the next claim takes away. The reconciler
    // refuses that collision at boot; this scope is what holds until a boot
    // happens.
    const userEmail = keyForEmail(user.email);
    for (const teamDecl of instanceConfig?.teams ?? []) {
      const match = (teamDecl.members ?? []).find((m) => m.email === userEmail);
      if (!match) continue;

      const teamRows = await db
        .select({ id: teams.id })
        .from(teams)
        .where(
          and(
            eq(teams.orgId, org.id),
            eq(teams.name, teamDecl.name),
            eq(teams.origin, "config"),
          ),
        )
        .limit(1);
      const teamRow = teamRows[0];
      if (!teamRow) continue;

      await db
        .insert(teamMembers)
        .values({ teamId: teamRow.id, userId: user.id, role: match.role })
        .onConflictDoUpdate({
          target: [teamMembers.teamId, teamMembers.userId],
          set: { role: match.role },
        });
    }
  };

  const accountCreateAfter = async (account: Account): Promise<void> => {
    const accessToken = account.accessToken;
    if (!accessToken) return;

    const owner = { type: "user" as const, id: account.userId };
    const credential = {
      type: "oauth2" as const,
      accessToken,
      refreshToken: account.refreshToken ?? undefined,
    };

    if (account.providerId === "google") {
      for (const service of GOOGLE_CREDENTIAL_SERVICES) {
        await credentialStore.save(owner, service, credential);
      }
    } else if (account.providerId === "github") {
      // Social GitHub login yields a token with better-auth's default
      // `read:user user:email` scopes — useful for identity, NOT for repos.
      // The token service (`services/github-tokens.ts`) treats
      // `metadata.identityOnly` as connect-state "identity-only" and excludes
      // it from repo-capable resolution; "Connect GitHub" (the App user-OAuth
      // flow) later overwrites this row with a repo-scoped credential.
      //
      // `expiresAt` is captured here so the refresh subsystem can keep the
      // token live. NOTE (create-only-hook limitation, spec decision 4):
      // better-auth fires `account.create.after` only on the FIRST link, so a
      // re-login that rotates the token does NOT re-run this hook — the
      // refresh subsystem, not this hook, is what keeps a linked token fresh.
      await credentialStore.save(owner, GITHUB_CREDENTIAL_SERVICE, {
        ...credential,
        expiresAt: account.accessTokenExpiresAt?.getTime(),
        metadata: { identityOnly: true },
      });
    }
  };

  /**
   * Mirrors the identity provider's groups into this user's teams, on every
   * single-sign-on login (`provisionUserOnEveryLogin`, set in
   * `auth/index.ts`). The rules live in `services/team-sync.ts`.
   *
   * Two things this function must never do:
   *
   * 1. Throw. The plugin awaits it BEFORE it sets the session cookie, so an
   *    exception here means nobody signs in. A database fault must cost one
   *    user one stale login, which the next login corrects. It must not lock
   *    the organization out.
   * 2. Write anything when the claim is missing. `readTeamClaim` runs first,
   *    and `ensureOrg` — which CREATES an org — stays behind that check.
   */
  const provisionUser = async (data: SsoProvisionData): Promise<void> => {
    // No OIDC config means no configured claim names. A provider registered
    // in the database carries no group claim through `userInfo` either,
    // because the extra fields are declared on the configured provider.
    const oidc = cfg.oidc;
    if (!oidc) return;

    try {
      const claim = readTeamClaim(data.userInfo, oidc.teamClaim, oidc.teamAssertedClaim);
      if (!claim.present) return;

      const org = await ensureOrg(db);
      await reconcileIdpTeams(db, {
        orgId: org.id,
        userId: data.user.id,
        claim,
        adminGroupName: oidc.teamAdminGroup,
        mirroredGroups: oidc.teamGroups,
        configPath,
      });
    } catch (err) {
      console.error(`team sync: reconcile failed for user ${data.user.id}:`, err);
    }
  };

  return {
    beforeHook,
    provisionUser,
    databaseHooks: {
      user: {
        create: {
          before: userCreateBefore,
          after: userCreateAfter,
        },
      },
      account: {
        create: {
          after: accountCreateAfter,
        },
      },
    },
  };
}
