# Team 1Password vaults

**Date:** 2026-09-04 (revised 2026-09-06)
**Status:** Accepted
**Ticket:** [TKAI-361](https://linear.app/turnkey/issue/TKAI-361)
**Relates to:** TKAI-204 (PR #421, #545), TKAI-205, `docs/specs/2026-07-21-onepassword-credentials-design.md`, `docs/specs/2026-09-01-sandbox-secret-broker-design.md`, `docs/specs/2026-08-24-team-credentials-and-workflow-bootstrap-design.md`

## What already works

The v2 1Password broker has landed for **org** and **personal** scopes (TKAI-204). `packages/api/src/services/onepassword.ts` is the only file that imports `@1password/sdk`. `OnePasswordScope` is `"org" | "personal"`. Token lookup is an org-owned `"onepassword"` row or a user-owned row. `op://` references resolve through that token.

TKAI-205 added `{ type: "team", id }` credential owners, `resolveTeamCredentialRead`, and the teams-panel credentials list. A team session and a team run read the org scope: every item the org service account can see (product decision 2026-09-06).

## Scope

This pass adds an optional restriction on top of the org scope. A team admin may narrow a team's 1Password reads to a named set of `op://` references. It does not add the team-owned service-account token the ticket describes. That token is still open; see "Open" below.

## Decisions

1. **Reuse the landed broker.** Team resolve calls the same `resolveReference` path. The org token is the source.

2. **A grant is an optional restriction, never a default denial.** With no grant row, a team read behaves as it did before this pass: the org scope, every reference the org token can see. When an admin has granted references, only those resolve. `loadTeamOnePasswordRefs` returns `null` for a team with no lease, and every caller treats `null` as "no restriction". A deploy therefore does not break a team session that never had a grant written.

3. **The grant rides on the `(team, "onepassword")` row as `metadata.refs`.** That row is the slot a team-owned service-account token will use (decision 2 of the team-credentials design: one credential per service per team). A grant write (`withGrantRefs`) keeps a token and any other metadata the row already holds. A grant clear (`withoutGrantRefs`) removes `refs` and keeps the row while it holds a token; it deletes a row that held only the grant. A future token therefore shares the row with no migration.

4. **Team admin grants and revokes.** `PUT` and `DELETE /api/teams/:id/onepassword-refs` require `canAdministerTeam`. `GET` uses `canViewTeam`: a team member or an org admin. No OwnerPicker. The expanded team on the Teams page is the place.

5. **A lease gates every `op://` reference a team read dereferences.** `resolveTeamCredentialRead` loads the lease once and applies it to the team row and to the org-provided row. The sandbox broker applies it to `resolve` and to `find`. An ungranted reference is refused with the corrective action: ask a team admin to grant it. The by-name vault search (`lookupInOnePassword`) stays on the org scope with or without a lease: a title match yields no reference to check, and `team-service-readiness.ts` mirrors that search as it stands.

6. **A refusal raised during action discovery is a failed result.** `resolveActions({ credentials })` in `action-invoker.ts` runs before the invoker's try. A typed refusal raised there returns `{ ok: false, error }` with the same message, so the workflow node reports the fix.

7. **One `op://` grammar.** `services/onepassword.ts` exports `OP_REFERENCE` and `isOnePasswordReference`. The credential write path, the sandbox broker, and the grant parser all use it, so a reference one of them stores is one the others accept.

8. **Delete the team, delete the lease.** `deleteTeam` deletes team-owned `credentials` rows in the same transaction.

9. **The token routes refuse the team scope for now.** `PUT /api/credentials/onepassword` with `scope=team`, the delegate route for `onepassword`, and team-scope `DELETE` answer 400 and name the refs routes. `GET /api/credentials?scope=team` hides the `onepassword` row. These refusals lift when the team token lands.

## Open

- **Team-owned service-account token** (ticket done-when 1). A team admin registers a token scoped to a team vault, and team reads use it before the org token. Decision 3 keeps the row shape ready for it. Until it lands, ticket done-when 4 (a member cannot read a team vault secret's plaintext) holds only as far as the org scope holds it: a member with a personal session reads the org scope today.

## Out of scope

- Replacing TKAI-204.
- Per-user service accounts beyond the personal scope that already shipped.

## Done when

A team session with no grant resolves every org-scope reference. A team session with a grant resolves a granted reference and is refused an ungranted one, on the team row, on the org-provided row, and through the sandbox broker. A grant write leaves a token on the shared row in place. Deleting the team row revokes the lease. Org and personal 1Password connect keep working as they do on `dev-v2` today.

## Testing

- `packages/api/src/services/team-onepassword-grant.test.ts`: parse, `null` for no lease, merge-safe row helpers.
- `packages/api/src/services/credential-resolution.test.ts`: no grant row resolves; granted and ungranted references on the team row and on the org-provided row.
- `packages/api/src/routes/sandbox-secrets.test.ts`: a team session with no grant reads every org reference in `resolve` and `find`; a lease narrows both.
- `packages/api/src/routes/team-onepassword-refs.test.ts`: admin writes, member and org admin read, stranger is refused, a token on the shared row survives a grant write and a grant clear.
- `packages/api/src/plugins/action-invoker.test.ts`: a lease refusal during `resolveActions` returns the typed error.
- `packages/api/src/routes/credentials.test.ts`: a reference the grant grammar refuses is refused at write time.
