# Team 1Password vaults

**Date:** 2026-09-04
**Status:** Accepted
**Ticket:** [TKAI-361](https://linear.app/turnkey/issue/TKAI-361)
**Relates to:** TKAI-204 (PR #421, #545), TKAI-205, `docs/specs/2026-08-24-onepassword-credential-broker-design.md`, `docs/specs/2026-08-24-team-credentials-and-workflow-bootstrap-design.md`

## What already works

The v2 1Password broker has landed for **org** and **personal** scopes (TKAI-204). `packages/api/src/services/onepassword.ts` is the only file that imports `@1password/sdk`. `OnePasswordScope` is `"org" | "personal"`. Token lookup is an org-owned `"onepassword"` row or a user-owned row. `op://` references resolve through that token.

TKAI-205 added `{ type: "team", id }` credential owners, `resolveTeamCredentialRead`, and the teams-panel credentials list. This ticket adds a team grant on top of that broker. It does not add a third service-account token.

## Scope

A team may use a named set of `op://` references from the vault the org already connected. This pass does not add a vault picker that lists the whole org vault on a team page.

## Decisions

1. **Reuse the landed broker.** Team resolve calls the same `resolveReference` path. The org token stays the usual source. A team does not get its own `"onepassword"` service-account row.

2. **Team access is a lease of explicit refs.** Store a `credentials` row with owner `{ type: "team", id: teamId }`, service `"onepassword"`, encrypted columns null, and `metadata.refs` holding the granted `op://` strings.

3. **Team admin grants and revokes.** `PUT` and `DELETE /api/teams/:id/onepassword-refs` require `canAdministerTeam`. Members and org admins may list granted refs. No OwnerPicker. The expanded team on the Teams page is the place.

4. **Resolution stops at the grant.** A team session or team workflow resolves a ref only when it is in `metadata.refs`. An ungranted ref returns the corrective action: ask a team admin to grant that reference. No fallback to a member's personal 1Password token and no fallback to the full org vault.

5. **Delete the team, delete the lease.** `deleteTeam` deletes team-owned `credentials` rows in the same transaction. The lease goes with them.

6. **Do not collide with the token write.** `PUT /api/credentials/onepassword` with `scope=team` is refused. The grant lives on the team route. `GET /api/credentials?scope=team` hides the grant row.

## Out of scope

- Replacing TKAI-204.
- Per-user service accounts beyond the personal scope that already shipped.
- A team-scoped connect that pastes a second token.

## Done when

A team session resolves a granted `op://` ref and is refused an ungranted one. Deleting the team row revokes access. Org and personal 1Password connect keep working as they do on `dev-v2` today.
