/**
 * Auth provisioning — the admission rule and the better-auth hooks that
 * enforce it (spec: docs/specs/2026-07-14-auth-v2-design.md §Provisioning
 * & invites). Ports v1's `finalizeIdentityLogin` semantics onto
 * better-auth's verified hook points.
 */
import { createAuthMiddleware, APIError } from "better-auth/api";
import type { Account, BetterAuthOptions, User } from "better-auth";
import type { CredentialStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { orgMembers, users } from "../schema/index.js";
import { ensureOrg } from "../services/org.js";
import type { AuthConfig } from "./config.js";
import { acceptInvite, findValidInviteByCode, findValidInviteByEmail } from "./invites.js";

export type Admission =
  | { allowed: true; role: "admin" | "member"; inviteId?: string }
  | { allowed: false };

function countUsers(db: AppDb): number {
  return db.select({ id: users.id }).from(users).all().length;
}

function domainOf(email: string): string | undefined {
  return email.trim().toLowerCase().split("@").pop();
}

/**
 * The single admission rule, used by both the signup invite gate and the
 * OAuth/SSO creation gate. Order (first match wins):
 *   1. zero users in the db → admin (bootstraps the first operator)
 *   2. email domain ∈ cfg.allowedEmailDomains (exact match, case-insensitive,
 *      no subdomain match) → member
 *   3. a valid invite matching by code, else by email → the invite's role
 *   4. otherwise → denied
 */
export function evaluateAdmission(db: AppDb, cfg: AuthConfig, email: string, inviteCode?: string): Admission {
  if (countUsers(db) === 0) {
    return { allowed: true, role: "admin" };
  }

  const domain = domainOf(email);
  if (domain && cfg.allowedEmailDomains.includes(domain)) {
    return { allowed: true, role: "member" };
  }

  const invite = (inviteCode && findValidInviteByCode(db, inviteCode)) || findValidInviteByEmail(db, email);
  if (invite) {
    return { allowed: true, role: invite.role, inviteId: invite.id };
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

export interface ProvisioningDeps {
  db: AppDb;
  cfg: AuthConfig;
  credentialStore: CredentialStore;
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
} {
  const { db, cfg, credentialStore } = deps;
  const pendingAdmissions = new Map<string, Admission>();

  const beforeHook = createAuthMiddleware(async (ctx) => {
    if (ctx.path !== "/sign-up/email") return;
    const body = (ctx.body ?? undefined) as Record<string, unknown> | undefined;
    const email = typeof body?.email === "string" ? body.email : "";
    const admission = evaluateAdmission(db, cfg, email, readInviteCode(body));
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
      admission = evaluateAdmission(db, cfg, user.email);
    } else if (isSocialPath(path)) {
      admission = evaluateAdmission(db, cfg, user.email);
      if (!admission.allowed) return false;
    } else {
      // "/sign-up/email" (already gated by beforeHook, above) or a null/internal
      // context (trusted caller) — re-run the same rule, with the invite code
      // from this request's body if one is available, to resolve the role to
      // stamp and to hand the matched invite (if any) to `.after`.
      admission = evaluateAdmission(db, cfg, user.email, readInviteCode(context?.body));
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

    const org = ensureOrg(db);
    const role: "admin" | "member" = user.role === "admin" ? "admin" : "member";
    db.insert(orgMembers).values({ orgId: org.id, userId: user.id, role, createdAt: Date.now() }).run();

    if (admission?.allowed && admission.inviteId) {
      acceptInvite(db, admission.inviteId, user.id);
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
      await credentialStore.save(owner, GITHUB_CREDENTIAL_SERVICE, credential);
    }
  };

  return {
    beforeHook,
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
