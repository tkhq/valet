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
 * DELIBERATE BEHAVIOR CHANGE: this retires the reference-rows-only org
 * fallback that used to live in `buildCredentialResolver` (session path).
 * That fallback resolved an org-owned row for a user-owner miss ONLY when
 * the row carried 1Password reference metadata; PLAIN org-owned rows (e.g.
 * an admin-pasted org-wide Linear API key) stayed invisible to sessions.
 * Under this contract, a user-owner miss on `resolveUserCredentialRead`
 * falls back to the org row regardless of kind — member sessions now read
 * ANY org-owned credential row when they have no row of their own for that
 * service, not just 1Password references. This mirrors the trust model the
 * org's shared 1Password token already has (an admin opts a credential into
 * org-wide sharing by creating the org-owned row at all) and matches
 * `github`'s existing user->org token-service tiering precedent.
 */
import type { CredentialStore, StoredCredential } from "@valet/engine";
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
export async function resolveUserCredentialRead(
  deps: CredentialReadDeps,
  ctx: Required<CredentialReadCtx>,
  service: string,
): Promise<StoredCredential | null> {
  if (isDeniedCredentialService(service)) return null;
  const userRow = await deps.credentials.get({ type: "user", id: ctx.userId }, service);
  if (userRow) return resolveRow(deps, userRow, ctx);
  const orgRow = await deps.credentials.get({ type: "org", id: ctx.orgId }, service);
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
