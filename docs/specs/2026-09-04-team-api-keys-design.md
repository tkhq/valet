# Team API keys

**Date:** 2026-09-04
**Status:** Proposed
**Ticket:** [TKAI-396](https://linear.app/turnkey/issue/TKAI-396)
**Relates to:** `docs/specs/2026-07-14-auth-v2-design.md`, `docs/specs/2026-08-24-team-credentials-and-workflow-bootstrap-design.md`

This is not an announcement blocker. TKAI-205 is integration credentials (`CredentialOwner.team`). This ticket is the HTTP `vlt_` key that CI uses to act as a team.

## Scope

A team admin can create, list, and revoke API keys that authenticate as the team principal. A personal `vlt_` key cannot create team-owned sessions or start team-owned workflows. There is no `OwnerPicker`. The workspace switcher supplies `teamId`.

## Context

Auth v2 stores keys in better-auth's `apikey` table (`packages/api/src/schema/index.ts`). `referenceId` is the user id. The auth ladder verifies the key, loads that user, and sets `c.var.user` (`packages/api/src/middleware/auth.ts`). Create, list, and revoke go through `authClient.apiKey` on Settings → You (`packages/web/src/components/settings/api-keys-section.tsx`).

CI that should open a team session or fire a team workflow today must use a person's key. That bills and authorizes as the person, and it breaks when that person leaves.

TKAI-205 does not cover this table. Its `credentials` rows are integration tokens (GitHub, Slack), not the Valet HTTP key.

## Decisions

1. **Keep the better-auth table.** Do not add `team_api_keys`. Put `{ teamId, createdBy }` in `apikey.metadata`. `referenceId` stays the creating admin so the vendor plugin keeps a user row.

2. **The key survives the creating admin leaving.** Revoke is `canAdministerTeam` or org admin. A membership check on the creating admin at request time would kill CI when that person leaves, which is the failure this ticket exists to close. Record `createdBy` in metadata for audit.

3. **Auth ladder promotes the principal.** After `verifyApiKey`, if metadata has `teamId`, require that the team still exists in the same org and set the request principal to `{ type: "team", id: teamId }`. Keep the creating user on the context for audit only. Routes that already accept a team owner (`POST /api/sessions`, workflow start) use that principal.

4. **Create, list, and revoke follow the workspace switcher.** Settings → API keys is the page. `CreateScopeLine` states the active workspace. Personal keys stay on personal scope. Team keys appear when the switcher is a team. Do not add an `OwnerPicker`. Do not bury the form under Organization → Teams: that page is not the switcher, and a create that used the switcher there would lie about the place.

5. **Authority equals a team member, not an org admin.** A team key may create team-owned sessions, start team-owned workflows, and read team-owned rows. It cannot change org settings, other teams, or personal resources. The middleware allowlist is GET `/api/me`, `/api/sessions*`, and `/api/workflows*`.

6. **One-time reveal stays as it is.** The secret is shown once at create, same as personal keys.

7. **`metadata.teamId` is server-only.** better-auth `enableMetadata` lets a signed-in caller write metadata on `/api/auth/api-key/create` and `/update`. A before hook refuses `teamId` on those routes. The team create path mints a key with no metadata, then stamps `{ teamId, createdBy }` in SQL and re-reads it before it returns the secret. Personal list, get, update, and delete refuse a row that already has `teamId`.

## Open question (default above)

If review prefers "key dies when the creating admin leaves," invert decision 2 and check `isTeamMember(createdBy)` on every request. The recommended default is survival plus admin revoke.

## Out of scope

- Team OAuth connect for integration credentials (TKAI-205 decision 9).
- Org-level API keys.
- Changing the `vlt_` prefix.

## Implementation

1. On create, require `canAdministerTeam` for the workspace `teamId`. Stamp `{ teamId, createdBy }` in SQL after `createApiKey`.
2. List filters `metadata.teamId` in SQL. Personal list omits team keys on the server.
3. Extend the auth ladder to promote a team-metadata key to a team principal. Reject the key if the team is gone or belongs to another org.
4. Session and workflow create paths use `resolveCreateOwner`. A team principal skips membership but still requires the team row under the ownership lock.
5. Web: `/settings/api-keys` follows the switcher. `CreateScopeLine`. No owner dropdown.

## Testing

- `packages/api/src/middleware/auth.ladder.test.ts` — team-metadata key authenticates; a deleted team is an invalid key.
- `packages/api/src/routes/team-api-keys.test.ts` — create/list/revoke gates; departed admin does not kill the key; a personal create cannot stamp `teamId`; a team key cannot create a personal assistant.
- Web test on `/settings/api-keys`: create states the workspace; no owner picker.

## Done when

A `vlt_` key created in a team workspace starts a team-owned session. A personal key cannot. Revoke from the team workspace kills the key. The creating admin can leave the team and the key still works until a team admin revokes it. A signed-in user cannot mint a team principal through `/api/auth/api-key/create`.
