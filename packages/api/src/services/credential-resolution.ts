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
 * `metadata.webhookSecret` (`routes/linear-connect.ts`), which the inbound
 * webhook verifies HMACs with, so handing whole org rows to member sessions
 * would hand out that secret. Reads are not free either —
 * `OAuthRefreshingCredentialStore.get` refreshes and writes back under the
 * owner it read, so an org read is an org write.
 *
 * This replaces the `service === "slack"` literal the session path used to
 * carry: `plugin-slack` declares `requires.orgCredential`, so the policy
 * covers it without naming it.
 */
import type { CredentialStore, StoredCredential, ValetPlugin } from "@valet/engine";
import { findCredentialDeclaration } from "./integration-availability.js";
import { ONEPASSWORD_SERVICE, onePasswordMeta, type OnePasswordService } from "./onepassword.js";

/** Internal services that must never surface as ordinary session/workflow
 * credentials. `onepassword` rows are the service-account tokens themselves;
 * `github_app` holds the GitHub App PEM/secrets; `llm:*` rows are org LLM
 * provider keys resolved only through the model/OpenAI probe paths. */
function isDeniedCredentialService(service: string): boolean {
  return service === ONEPASSWORD_SERVICE || service === "github_app" || service.startsWith("llm:");
}

export interface CredentialReadDeps {
  credentials: CredentialStore;
  onePassword?: OnePasswordService;
}

export interface CredentialReadCtx {
  orgId: string;
  userId?: string;
}

/**
 * Resolves a raw store row through 1Password when applicable. `onePassword`
 * absent, or the row carries no `metadata.onepassword` -> the row is
 * returned UNCHANGED (same object reference, no clone) so a non-1Password
 * deployment/row is byte-identical to a plain `CredentialStore.get` read.
 * `OnePasswordAuthError` from `resolveCredential` propagates unchanged.
 */
async function resolveRow(
  deps: CredentialReadDeps,
  row: StoredCredential | null,
  ctx: { orgId: string; userId: string },
): Promise<StoredCredential | null> {
  if (!row) return null;
  if (!deps.onePassword || !onePasswordMeta(row)) return row;
  return deps.onePassword.resolveCredential(row, ctx);
}

/**
 * User->org precedence read for ALL credential kinds, plus 1Password
 * reference resolution. `ctx.userId` is required (`Required<CredentialReadCtx>`)
 * — this is the "acting as a specific user" half of the contract; a
 * personal-tokenScope reference on either row resolves against that user id.
 *
 * Precedence: the `{ type: "user", id: ctx.userId }` row wins outright when
 * present (any kind, reference or plain) — the org row is never even read in
 * that case. Only on a user-row MISS does this fall back to the
 * `{ type: "org", id: ctx.orgId }` row for the same service.
 */
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

export async function resolveUserCredentialRead(
  deps: CredentialReadDeps,
  ctx: Required<CredentialReadCtx>,
  service: string,
  orgFallback: OrgFallback,
): Promise<StoredCredential | null> {
  if (isDeniedCredentialService(service)) return null;
  const userRow = await deps.credentials.get({ type: "user", id: ctx.userId }, service);
  if (userRow) return resolveRow(deps, userRow, ctx);
  if (orgFallback === "none") return null;
  // Skip the org read entirely when only a reference could qualify and no
  // 1Password service is wired. `CredentialStore.get` is NOT side-effect free:
  // `OAuthRefreshingCredentialStore` refreshes on read and writes the result
  // back under the owner it read, so an org read is an org write.
  if (orgFallback === "reference-only" && !deps.onePassword) return null;
  const orgRow = await deps.credentials.get({ type: "org", id: ctx.orgId }, service);
  if (!orgRow) return null;
  // A plain org row stays invisible. An org-owned `linear` row carries
  // `metadata.webhookSecret` (`routes/linear-connect.ts`), so returning the
  // whole row to every member's session would hand out the webhook HMAC.
  if (orgFallback === "reference-only" && !onePasswordMeta(orgRow)) return null;
  return resolveRow(deps, orgRow, ctx);
}

/**
 * Org-row-only read (no user row is ever consulted), plus 1Password
 * reference resolution — for readers with no live user in scope (ChannelHost
 * bot tokens, org-owned workflow runs). Without `ctx.userId`, a
 * personal-tokenScope reference on the org row resolves against
 * `userId: ""`, which `OnePasswordService.resolveCredential` turns into the
 * typed `OnePasswordAuthError` (no personal token owner to look up) rather
 * than a silent null — callers must handle that error explicitly.
 */
export async function resolveOrgCredentialRead(
  deps: CredentialReadDeps,
  ctx: CredentialReadCtx,
  service: string,
): Promise<StoredCredential | null> {
  if (isDeniedCredentialService(service)) return null;
  const orgRow = await deps.credentials.get({ type: "org", id: ctx.orgId }, service);
  return resolveRow(deps, orgRow, { orgId: ctx.orgId, userId: ctx.userId ?? "" });
}
