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

1. **Keep the better-auth table.** Do not add `team_api_keys`. Put `{ teamId, createdBy }` in `apikey.metadata`, and the same team id in a Valet-owned nullable `apikey.team_id` column with an index. The auth ladder reads the metadata (it is what `verifyApiKey` returns); the team list and revoke read the column. One UPDATE writes both, and create re-reads both before it returns the secret. The list projects the summary columns only; the hash never leaves the table. `referenceId` stays the creating admin so the vendor plugin keeps a user row. The personal list filter recomputes `total` and refuses an unknown response shape instead of passing it through.

2. **The key survives the creating admin leaving.** Revoke is `canAdministerTeam` or org admin. A membership check on the creating admin at request time would kill CI when that person leaves, which is the failure this ticket exists to close. Record `createdBy` in metadata for audit.

3. **Auth ladder promotes the principal.** After `verifyApiKey`, if metadata has `teamId`, require that the team still exists in the same org and set the request principal to `{ type: "team", id: teamId }`. Keep the creating user on the context for audit only. Routes that already accept a team owner (`POST /api/sessions`, workflow start) use that principal.

4. **Create, list, and revoke follow the workspace switcher.** Settings → API keys is the page. `CreateScopeLine` states the active workspace. Personal keys stay on personal scope. Team keys appear when the switcher is a team. Do not add an `OwnerPicker`. Do not bury the form under Organization → Teams: that page is not the switcher, and a create that used the switcher there would lie about the place.

5. **Authority is limited to team session and workflow routes.** A team key may read, run, and change its team-owned sessions and workflows, and delete sessions, subject to route and resource guards. Deleting a workflow definition requires a human team or organization admin; a team key receives 403 (TKAI-430). It is not a read-only key. It cannot change org settings, other teams, or personal resources. The middleware allowlist is GET `/api/me`, `/api/sessions` and paths below it, `/api/workflows` and paths below it, and POST `/api/teams/:id/orchestrator` for the key's own team. The match is on path segments, so `/api/sessionsX` is refused.

   `valet send` without `--session` targets the caller's default assistant. For a team key that is the team's, reached through `POST /api/teams/:id/orchestrator` with no membership check on the creating admin. The CLI reads `GET /api/me` once per command and posts the team route when the answer has `role: "team"`; a personal credential keeps posting `/api/orchestrator`.

   Every session and workflow check reads the request principal, never `c.var.user`. On a team key `c.var.user` is the creating admin, and `agent_sessions.userId` on every row that admin touched is that admin, so a check on the user would hand the key the admin's personal sessions. `canViewSession`, `canAdministerSession`, `canResolveSessionGate` and `WorkflowOwner` all take the principal. The gateway proxy, sandbox replace and `sandbox-jwt` gate on direct ownership (`isSessionDirectOwner`); `sandbox-jwt` refuses a team key because the token binds one user.

   `GET /api/me` answers a team key with the team (`TeamMeResponse`: id, name, orgId, `role: "team"`, no email), not the creating admin. The route stays on the allow-list rather than refusing, because `valet login` verifies a key through it and `valet send` reads the team id off the answer to find the team's default assistant. `PATCH /api/me` stays refused.

   The LLM gateway (`/proxy/*`) refuses a team key with a 401 that names the fix. The gateway bills a user, and the only user on a team key is the creating admin, kept for audit. The refusal stands until a team billing principal exists.

   Routes mounted before the scope gate apply it themselves. The pre-auth artifact router resolves its caller through `resolveOptionalIdentity`, which returns the principal with the user. A team key there counts as anonymous: it reads a public artifact, and it is refused with a 403 that names the fix on an org-visibility artifact and on every comment route.

6. **One-time reveal stays as it is.** The secret is shown once at create, same as personal keys.

7. **`metadata.teamId` is server-only.** better-auth `enableMetadata` lets a signed-in caller write metadata on `/api/auth/api-key/create` and `/update`. A before hook refuses `teamId` on those routes. The team create path mints a key with no metadata, then stamps `{ teamId, createdBy }` in SQL and re-reads it before it returns the secret. Personal list, get, update, and delete refuse a row that already has `teamId`.

## Open question (default above)

If review prefers "key dies when the creating admin leaves," invert decision 2 and check `isTeamMember(createdBy)` on every request. The recommended default is survival plus admin revoke.

## Out of scope

- Team OAuth connect for integration credentials (TKAI-205 decision 9).
- Org-level API keys.
- Changing the `vlt_` prefix.

## Implementation

1. On create, require `canAdministerTeam` for the workspace `teamId`. Stamp `{ teamId, createdBy }` in metadata and `team_id` in one SQL statement after `createApiKey`; re-read both before returning the secret. The final authorization check, stamp, and read share the team ownership lock with deletion.
2. List filters on the indexed `team_id` column and projects the summary columns. Personal list omits team keys on the server and recomputes `total`.
3. Extend the auth ladder to promote a team-metadata key to a team principal. Reject the key if the team is gone or belongs to another org.
4. Session and workflow create paths use `resolveCreateOwner`. A team principal skips membership but still requires the team row under the ownership lock.
5. Every session and workflow read gates on `c.var.principal` (`canViewSession`, `canAdministerSession`, `canResolveSessionGate`, `WorkflowOwner.principal`); the gateway proxy, sandbox replace and `sandbox-jwt` gate on `isSessionDirectOwner`.
6. Pre-auth and out-of-band surfaces apply the scope themselves: the public artifact router treats a team key as anonymous, the LLM gateway refuses it.
7. `GET /api/me` answers a team key with `TeamMeResponse`; the CLI posts `/api/teams/:id/orchestrator` for a team identity.
8. Web: `/settings/api-keys` follows the switcher. `CreateScopeLine`. No owner dropdown.

## Testing

- `packages/api/src/middleware/auth.ladder.test.ts` — team-metadata key authenticates as the team; a deleted team is an invalid key.
- `packages/api/src/routes/team-api-keys.test.ts` — create/list/revoke gates; the `team_id` column agrees with the metadata; departed admin does not kill the key; a personal create cannot stamp `teamId`; a team key cannot create a personal assistant; `GET /api/me` answers with the team and `PATCH` is refused.
- `packages/api/src/routes/team-api-keys.access.test.ts` — one admin, one personal and one team session: the key reads, rates, opens the socket, reaches the gateway and the security surface of the team session only, is refused on `sandbox-jwt`, and wakes its own team's orchestrator only.
- `packages/api/src/routes/team-api-keys.workflows.test.ts` — the key lists, schedules and previews team workflows only.
- `packages/api/src/routes/team-api-keys.artifacts.test.ts` — the pre-auth artifact router: public read as anonymous, org read and comments refused.
- `packages/api/src/proxy/principal.test.ts` — the LLM gateway refuses a team key before the org lookup.
- `packages/api/src/lib/request-principal.test.ts` — the allow-list matches path segments and the key's own team orchestrator.
- `packages/api/src/cli/client.test.ts` — `ensureOrchestrator` follows `GET /api/me`.
- `packages/api/src/lib/personal-api-key-list.test.ts` — the personal list drops team rows, recomputes `total`, and refuses an unknown shape.
- `packages/api/src/schema/pg-schema.test.ts` — the `team_id` column and index are restored by the repair pass.
- Web test on `/settings/api-keys`: create states the workspace; no owner picker.

## Done when

A `vlt_` key created in a team workspace starts a team-owned session. A personal key cannot. Revoke from the team workspace kills the key. The creating admin can leave the team and the key still works until a team admin revokes it. A signed-in user cannot mint a team principal through `/api/auth/api-key/create`. The key reads nothing outside its team: not the creating admin's sessions, workflows, triggers, memory or artifacts, and not another team's orchestrator. `valet send` with the key and no `--session` prompts the team's default assistant.

## Deviations from this design (recorded at implementation)

1. **A team key is refused on sandbox replace as well as on `sandbox-jwt`.** Decision 5 gates `POST /api/sessions/:id/sandbox/replace` on direct ownership and names `sandbox-jwt` as the one route that refuses a team key outright. A team key is the direct owner of its team's sessions, so the ownership gate alone admitted it to a rebuild of a live team session. What shipped refuses a team principal on sandbox replace with the same 403 that `sandbox-jwt` gives, naming a personal key or the web app as the fix. Rebuilding a sandbox is a person's act on a session, not a key's. Recorded 2026-09-07.


### Team deletion (TKAI-446)

Deleting a team removes its API key rows in the same transaction. Keys belonging to other teams and personal keys remain. Authentication already refuses keys whose team is missing; this change removes the stored rows as well.

Concurrent key creation uses the same `lockTeamForOwnership(tx, teamId)` lock as team deletion (#624). Better-auth mints outside the transaction. After minting, the route takes the lock and rechecks the team in the caller's org and the caller's administration rights. The route writes and verifies both team pins through `tx` before releasing the lock. It never calls the outer database handle inside that transaction.

If deletion or lost authorization wins, creation returns 404 without the secret. A failed pin returns 500 without the secret. After the transaction settles, the route deletes the minted row on either failure, including transaction errors. If creation wins, team deletion removes the pinned row through its existing cleanup.

The route regression suite completes team deletion after a real better-auth mint and before the final pin. It verifies 404, no secret, no stored key, and failed authentication. Additional cases cover lost administration rights, a missing minted row, and a pin write error. The existing create, revoke, and authorization tests remain.


### Authority copy (TKAI-445)

The team key form states its mutation authority and lifetime before creation. This changes the explanation, not the permission model. Existing route restrictions, approval rules, repository-owned resource guards, and unsettled-run guards still apply.

TKAI-430 narrows workflow-definition deletion to human administrators. Team-key copy names this restriction; session deletion and other allowed workflow operations remain available.
