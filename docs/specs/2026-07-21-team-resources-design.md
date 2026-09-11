# Team-Owned Resources: Orchestrators, Shared Workflows, Team & Delegated Credentials (v2)

Date: 2026-07-21
Status: approved design
Depends on: RBAC permissions (`2026-07-21-rbac-permissions-design.md`, ships first — this spec is the first consumer of its resource-context seam), orchestrator engine design (`2026-07-11-orchestrator-engine-design.md` — identity model, credential-by-reference, access rules; this spec implements its team surface), integration OAuth (`2026-07-20-integration-oauth-design.md` — connect flow reused for team scope)

## Problem

Teams exist in v2 as a membership structure and nothing more. Every resource that matters — orchestrators, workflows, credentials — is user-owned; the schema's `team` owner enums are dead columns, `routes/workflows.ts` hardcodes `owner="user"` in every query, `CredentialOwner` lacks `team` entirely, and `action-invoker` explicitly refuses team-owned runs ("team-owned runs have no credential scope today"). The orchestrator-engine design already describes the target ("Team membership is the sole access path to team-owned resources — sessions, memory, credentials, workflows"); this spec turns that section plus the RBAC resource axis into a buildable surface.

## Decision summary

1. **Members use, admins manage.** All team members: chat with the team orchestrator, run shared workflows, have team-owned runs resolve team credentials, read team memory. Team admins additionally: create/edit/delete shared workflows, connect/disconnect team credentials, accept/remove delegations, configure the orchestrator identity. Org admins retain the recovery override everywhere (existing `canMutateTeam` posture).
2. **Enforcement through the RBAC seam with resource context**: `can(principal, permission, { teamId })`. Team roles map to permission bundles exactly like org roles do. Routes never match team-role names.
3. **Two kinds of team credentials, one keyspace.** *Direct* team credentials (a team admin connects a service for the team — OAuth or token entry, same flows as user scope) and *delegated references* (a member shares one of their connected services with the team). Both live in the `credentials` table under `owner {type:"team", id}`; the PK `(ownerType, ownerId, service)` means one credential per service per team — direct or delegated, never both.
4. **Delegation is by reference, never by copy** (orchestrator-engine design §credential delegation). A delegated row stores NO secret material — only `metadata: { delegatedFrom: userId }`. Resolution follows the reference to the member's live user credential at use time. Revocation (by the member, from their own integrations page, or removal by a team admin) deletes the reference; subsequent resolution **fails visibly** — actions error with a "credential reference broken" message; nothing silently borrows another credential.
5. **No actor fallback.** A team-owned run/session resolves team-owned credentials only. It never falls back to the triggering member's personal credentials — a team workflow that works for one member and breaks for another is a debugging trap; failing uniformly is the feature.
6. **Actor is always a human.** Team-owned sessions/runs carry `owner = {type:"team"}` and `actorUserId` = the triggering member (already plumbed via `orchestratorSessionFor`'s actor≠owner split). Run history and orchestrator turns are attributed to the actor.
7. **Sequential delivery in three phases** (credentials → workflows → orchestrators), each independently shippable and PR'd separately.

## What this spec does NOT cover

- Org-owned workflows and the org orchestrator's full "chief of staff" behavior (orchestrator-engine design; separate pass).
- Channel bindings to teams (`channel_bindings.ownerType` enum is ready; routing logic is a later pass).
- Session sharing for plain user sessions (viewer/collaborator — still blocked on the participant model).
- Custom team roles (two roles: `admin` | `member`, as today).
- Delegation to org scope, or per-workflow delegation grants (per-service+per-team only, per design decision).

## Access model (RBAC resource axis, first consumer)

Extends the RBAC spec's vocabulary with team-context permissions and implements the `can(principal, permission, { teamId })` overload:

```ts
// auth/permissions.ts additions
export const TEAM_PERMISSIONS = [
  "team:resources:use",     // run shared workflows, chat with team orchestrator, team-credential resolution in one's runs
  "team:workflows:manage",  // create/edit/delete shared workflows
  "team:credentials:manage",// connect/disconnect team credentials, remove delegations
  "team:orchestrator:manage", // PATCH team orchestrator identity/personality
  "team:manage",            // existing membership management (formalizes canMutateTeam)
] as const;

export const TEAM_ROLE_PERMISSIONS = {
  admin:  [all of the above],
  member: ["team:resources:use"],
} as const;
```

- `can(principal, permission, { teamId })` resolves the caller's `team_members.role` for that team (membership re-checked per request, per the orchestrator design's action-time rule), applies `TEAM_ROLE_PERMISSIONS`, and grants org admins (`members:manage` holders) the full team set as the recovery override.
- Non-members have the empty set — 404 on team resources (matching the existing cross-owner 404 posture), 403 only where the team's existence is already known to the caller (mutations inside a team surface).
- Existing `routes/teams.ts` gates (`canMutateTeam`, roster reads) are migrated onto `team:manage` / membership checks — behavior-preserving.
- OAuth-scope compatibility: these are global permission *names*; a future scoped token carries the name plus a resource qualifier. Nothing here invents a second vocabulary.

## Phase A — Team credentials + delegation

### Engine

`CredentialOwner` union gains `"team"` (`packages/engine/src/types.ts`) — storage layer (`credential-store.ts`) already handles arbitrary owner strings; no store changes.

### Resolution: the reference-resolving wrapper

A `TeamCredentialStore`-style decorator (packages/api, composed with the existing `OAuthRefreshingCredentialStore` — reference resolution OUTSIDE, refresh INSIDE, so a followed reference refreshes through the **source user's** row and a direct team credential refreshes under the team owner):

- `get({type:"team",id}, service)`:
  - row absent → null;
  - row has secret material (direct) → return it (refresh decorator already applied);
  - row is a reference (`metadata.delegatedFrom`) → **re-check the delegator is still a member of the team**; then `get({type:"user", id: delegatedFrom}, service)`; if the member's credential is gone or membership lapsed → throw a typed `CredentialReferenceBrokenError` (the action surface renders "team credential for <service> is delegated from a member whose connection is no longer available — reconnect or re-delegate").
- `action-invoker.credentialOwnerFor` maps `{type:"team"}` through instead of returning null; the workflow invoker's provider consults the wrapper. Session-side (`Session.credentialProvider`) picks the owner from the session's `owner` principal (today it always builds user owners; team-owned orchestrator sessions build `{type:"team"}`).

### Routes (`routes/credentials.ts` + `credential-connect.ts`)

- `scope=team&teamId=…` joins the existing `user`/`org` scopes on GET/PUT/DELETE. GET requires membership (`team:resources:use`); PUT/DELETE require `team:credentials:manage`. Summaries mark delegated rows (`delegatedFrom` + delegator's name) and never leak secrets (unchanged posture).
- OAuth connect: `GET /api/credentials/:service/connect?scope=team&teamId=…` — requires `team:credentials:manage`; the signed state carries the owner tuple; the callback persists under the team owner. (State shape gains `owner`; the existing user flow is the `owner` default.)
- **Delegation grant**: `POST /api/credentials/:service/delegate` body `{ teamId }` — any member may delegate **their own** connected service to a team they belong to. Creates the reference row under the team owner (`409` if the team already has that service — a team admin must remove the existing credential first; deliberate, keeps the one-per-service invariant visible). **Revocation**: `DELETE /api/credentials/:service/delegations/:teamId` by the delegator (always, no team permission needed — it's their credential) or via the team-scoped DELETE by a team admin. Deleting one's own user credential also cascades its delegation rows (a reference must never outlive its source).

### Web

- `/integrations`: each connected service row gains a "Share with a team…" action (member's own view) listing their teams; delegated-state shown on both sides (the member sees where they've shared; the team credentials view shows "delegated from <name>").
- Team settings page gains a Credentials tab (direct connect via the same Connect/manual affordances, delegation list, disconnect) — visible to members, mutable per `team:credentials:manage`.

## Phase B — Shared workflows

- `routes/workflows.ts` drops the hardcoded `owner="user"`: an optional `?team=<id>` (list) / `owner` field (create) selects the team scope. Listing merges "mine" + each of my teams' (or stays per-scope with an explicit param — decided in the plan by what the web UI needs; API must support per-scope queries either way).
- Gates: list/get/run + approvals → `team:resources:use`; create/PUT/delete → `team:workflows:manage`. Approvals by any run-capable member (whoever can run can approve); the run row records the approving actor.
- Runs: `workflow_runs.ownerType/ownerId` = team; `actorUserId` recorded on the run (new column on `workflow_runs`, pre-1.0 edit) and shown in run history ("run by <name>").
- Tool-node credential resolution flows through Phase A's wrapper (team owner). The existing "credential resolution is not supported for owner type team" error disappears.
- Attention/notifications for team-owned runs (approval pending, failure) route to all team members, deduped per user (`routeAttention` fan-out over `listTeamMembers`; `dedupeKey` unchanged per run+node).
- Web: workflows list grows an owner switcher (Personal / each team); team workflows badge their team; editor mutations hidden without `team:workflows:manage`.

## Phase C — Team orchestrators

- `POST /api/teams/:id/orchestrator` (ensure), `GET /api/teams/:id/orchestrator/info`, `PATCH …/info` — thin wrappers over the existing principal-generic path (`ensureOrchestratorSession`, `orchestratorSessionFor`, `orchestrator_identities`), with `teamPrincipal(teamId)`. Ensure + info-read require `team:resources:use`; PATCH requires `team:orchestrator:manage`.
- Session access: team-owned sessions (the orchestrator and its spawned children, which inherit team ownership per the orchestrator design) are accessible to **current** team members — the session routes' owner gate learns `owner.type === "team"` → membership check (re-checked per request), alongside the existing user-equality rule. Actor = the requesting member (`actorUserId` on each turn, already plumbed).
- `queueMode: "followup"` for non-user principals is already implemented; memory scope = team owner is already supported (writes land under `team:{id}`, members' user-scope reads already union it in).
- Credentials inside the team orchestrator session resolve under the team owner via Phase A (no actor fallback — decision 5).
- Web: team settings gains an Orchestrator tab (identity/personality per `team:orchestrator:manage`) and a "Chat" entry for members; the team orchestrator appears in the session/chat navigation for its members.

## Delivery order and rationale

| Phase | PR | Unblocks |
|---|---|---|
| A: credentials + delegation | `feat/team-credentials` | B and C both need team credential resolution; delegation is the highest-value standalone piece |
| B: shared workflows | `feat/team-workflows` | first user-visible team collaboration surface; exercises A's resolution in the headless invoker |
| C: team orchestrators | `feat/team-orchestrators` | exercises A in live sessions + session-access-by-membership; largest UI surface |

Each phase: own plan (`docs/plans/`), own PR against `dev-v2`, spec Deviations updated in the same branch. The RBAC pass (`2026-07-21-rbac-permissions-design.md`) must merge first — Phase A starts by implementing its `can(…, { teamId })` overload.

## Testing (per phase, high-signal cases)

- **A**: reference resolution follows to the live source credential (fresh token after the source refreshes); revocation → typed broken-reference error, never a fallback; delegator-leaves-team → broken reference; one-per-service 409; delegator can always revoke; non-admin member cannot PUT/DELETE team scope; user-credential delete cascades delegations; OAuth connect round trip with team owner in the signed state.
- **B**: member can run/approve but not edit; admin edits; non-member 404s; run history carries actor; team run resolves team credential via invoker (fixture plugin); notification fan-out dedup.
- **C**: member chats, non-member 404s (session route membership gate); PATCH info admin-only; child session inherits team ownership; membership removal revokes access on next request; orchestrator turn resolves team credential.
- **Live pass per phase** (human-in-the-loop): A — delegate a real Linear credential to a team and run a team workflow against it; C — two-browser check (alice admin, bob member) on the team orchestrator.

## Out of scope / follow-ups

- Org-owned workflows + org orchestrator behavior pass.
- Team channel bindings (Slack/Telegram routing to team orchestrators).
- Delegation audit surface (who used my delegated credential when) beyond run-history actor attribution.
- Per-workflow delegation grants (revisit only if per-team proves too broad in practice).

## Personal resource copies (TKAI-431, 2026-09-10)

The personal assistant can copy an explicitly named memory file or workflow
into a destination team. These operations do not move resources. They leave
source content, ownership, schedules, event subscriptions and webhooks unchanged.
The caller chooses the destination team and path or name. A conflict fails with
corrective text; the service does not overwrite an existing destination.

- `mem_copy_to_team` calls `POST /api/memory/copy-to-team` with
  `{ from, to, teamId }`. The source must belong to the acting user. The service
  requires destination membership plus `canAdministerTeam`, the existing memory
  write authority, including on authenticated internal tool requests. The team
  supplies the destination org ID. Content and metadata are copied without LLM
  reconstruction. Version history starts at one; source-session and mirror
  bindings are cleared. The response identifies the destination by owner and path.
- `workflows.copy_to_team` calls the existing workflow copy service with
  `{ workflow_id, team_id, name }`. HTTP callers use
  `POST /api/workflows/:id/copy-to-team` with `{ teamId, name }`. Source access
  follows the workflow read check, then requires personal ownership. Destination
  access follows the implemented workflow creation rule: membership in a team
  within the caller's org. This is the current service rule, not the proposed
  admin-only gate in Phase B above. HTTP retains the creation API-key restrictions.
  The copy gets a new workflow ID and version-one snapshot. Team assistant and
  team-key contexts cannot copy an actor's personal graph.

Both services use the existing team ownership lock around destination checks
and creation. Memory insertion also uses the owner/path unique key to reject a
conflict. Workflow names are checked within that lock. No copy creates runs,
active triggers, webhook secrets, credentials or execution grants.

Memory links and nested workflow references remain unchanged. This operation
copies only the named resource, not its dependencies. Referenced personal
resources may remain unavailable to the team. The workflow action reports this
limit so the assistant can arrange explicit dependency copies and remapping.

Artifact copies use `artifact_copy_to_team` and the existing artifact store.
The server checks personal ownership and destination membership in the same organization.
A copy gets a new ID, token and version history. Its default audience is the organization,
as on ordinary publish; team ownership does not make an artifact link team-private.
Public grants, comments and source-session links do not transfer. A key collision refuses the copy.

## Bidirectional personal/team knowledge transfers (2026-09-10)

Bidirectional means an explicit pull from a team and an explicit push to a team.
Knowledge in this scope is the existing memory-file corpus, including Markdown documents under `artifacts/`.
The TKAI-431 push remains `mem_copy_to_team` and `POST /api/memory/copy-to-team`.
The new pull uses `mem_copy_from_team` and `POST /api/memory/copy-from-team`.
Both accept `{ teamId, from, to }` and return `{ file }` with status 201.
Paths are relative to their respective owners. Virtual `team:{id}/` prefixes are read-only and are rejected as copy paths.

Both directions use one copy service. The caller must act as their own personal principal.
Team assistants, team API keys, and foreign personal scopes cannot transfer through an actor's personal memory.
Pull checks source-team membership before reading the team file. Push checks destination membership and existing team memory write authority.
These checks also apply to internal tool requests. The transaction holds the team ownership lock and shared team and membership-row locks through insertion.
Push also locks the actor’s target-org membership row before evaluating an org-admin grant.
Concurrent demotion or removal cannot revoke a locked grant between its check and the insert.
The source query includes its owner tuple. The destination owner comes from the checked team or the authenticated personal scope.
Personal copies use the same empty org ID as ordinary personal memory writes.

`MemoryScope` intentionally has no active org field. Existing reads discover all teams through `listTeamsForUser` without an org filter.
Transfers preserve that cross-organization memory contract: an actor can transfer with a team in any organization where they hold membership.
Push checks admin authority in the target team’s organization, never an unrelated or active organization.
The HTTP request’s active org and the tool context’s org do not narrow this memory scope.
Changing that rule requires a separate change to memory reads, writes, and discovery.

Each operation copies one current file and preserves its original. Content, metadata, and links remain unchanged.
The copy starts at version one. Source-session and mirror bindings are cleared; no share record transfers.
A destination collision returns status 400 with an instruction to choose another path, matching the existing push contract.
The owner/path unique key also rejects concurrent collisions. There is no overwrite, merge, or automatic rename option.
The user can choose a new path or skip the transfer.

The memory skill explains team discovery through `mem_read` and `mem_search`, with pull and push examples.
Both tools are registered in the standard assistant memory tool list.
The memory document view offers “Push to a team” for personal files and “Pull to personal memory” for team files.
The form requires a destination path and an explicit submission. Push lists teams from the current organization’s existing team picker.
The form uses the shared Input and DropdownMenu primitives.
Unavailable teams stay disabled with a short admin-access explanation. Loading, retry, empty, collision, and success states are visible.
The API and tools retain cross-organization memory access; the web team picker remains current-org scoped.
Workflow and published-artifact copy services remain unchanged. This scope excludes bulk copies, dependency rewriting,
background sync, and outward repository publishing from the broader TKAI-432 work.

Validation covers both directions, exact content and metadata, unchanged originals, collisions, concurrent pulls,
member-only pull access, denied push access, revoked membership, forged scopes, malformed HTTP requests, and real tool/HTTP round trips.
