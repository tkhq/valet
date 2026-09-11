# Team resource deletion requests

**Date:** 2026-09-09
**Status:** Implemented (2026-09-11)
**Relates to:** `docs/specs/2026-08-24-team-credentials-and-workflow-bootstrap-design.md`, `docs/specs/2026-09-04-team-api-keys-design.md`, `docs/specs/2026-09-04-team-onepassword-vaults-design.md`, `docs/specs/2026-08-17-team-workspace-ui-design.md`

**Scope:** This spec owns one flow. A member of a team who may not delete a team-owned resource asks a team admin to delete it, and a team admin approves or declines. It decides which resources the flow accepts, where a request row lives, how a request reaches a team admin, what a member sees in place of today's 404, and what happens on expiry, on a duplicate submission, and when the requester leaves the team. It also tightens two delete gates that are member-level today, so that "a team admin gates deletion" is true for every team resource and not for six of eight. It does not change who may create or edit anything: the 2026-09-09 call kept creation open to every member, and creation is already open. It does not add an org-level approval flow, because org resources are already org-admin-only on every path this spec read. It adds no permission vocabulary and no new authorization predicate: `isTeamMember` and `canAdministerTeam` stay the two gates.

Historical design citations were read on branch `verify/merged` at `tkhq/dev-v2` tip `7953d70cf`.

## Context

### Who may do what today

Every row below was read, not inferred. "Member" means a live row in `team_members` for that team. "Admin" means `canAdministerTeam` (`packages/api/src/services/teams.ts:568-580`), which is a team admin of that team or an admin of the team's org. `canViewTeam` (`teams.ts:537-543`) is the read counterpart: a member, or an org admin.

| Team resource | Create | Edit | Delete | A member who is refused sees |
| --- | --- | --- | --- | --- |
| The team | Any org member (`routes/teams.ts:419-470`) | Admin (`routes/teams.ts:491`) | Admin (`routes/teams.ts:573`) | 404 |
| Workflow, `origin='local'` | Member (`workflows/service.ts:570`) | Member (`service.ts:295-303`) | **Member** (`service.ts:1003-1008`) | nothing, the delete succeeds |
| Workflow, `origin='repo'` | sync only | refused for all (`service.ts:207-212`) | refused for all | 409 with the repository named |
| Skill, `origin='local'` | Member (`services/skills.ts:128-139`) | Member | **Member** (`skills.ts:644-657`) | nothing, the delete succeeds |
| Skill, `origin='repo'` | sync only | refused for all | refused for all (`routes/skills.ts:563-567`) | 409 |
| Content source, workflows or templates | Admin (`services/content-sources.ts:328-340`) | n/a | Admin (`content-sources.ts:562-566`) | 404 |
| Content source, skills only | Member (`content-sources.ts:376-380`) | n/a | Admin (`content-sources.ts:562-566`) | 404 |
| Credential | Admin (`routes/credentials.ts:143-149`) | Admin | Admin (`routes/credentials.ts:765-771`) | 404 |
| API key | Admin (`routes/team-api-keys.ts:101`) | n/a | Admin (`routes/team-api-keys.ts:158`) | 404 |
| Assistant or session | Member | Admin (`services/session-access.ts:106-114`) | Admin | 404 |
| Memory file | Admin (`routes/memory.ts:132-135`) | Admin | Admin | 404 |
| 1Password lease | Admin (`routes/teams.ts:740`) | Admin | Admin (`routes/teams.ts:780`) | 404 |

Three of the call's asks are already satisfied, and nobody should build them again.

**Team creation is already open to every org member.** `POST /api/teams` runs one gate, and that gate refuses a team API key rather than a person (`routes/teams.ts:419-421`, `refuseTeamApiKey` at `routes/teams.ts:243-250`). The creator is inserted as the team's admin in the same transaction (`services/teams.ts:375`). The page that hosts the form says the same thing in its own header (`packages/web/src/routes/settings.organization.teams.tsx:11-15`).

**Team deletion already requires a team admin.** `routes/teams.ts:573` runs `canAdministerTeam` and answers 404 when it fails.

**Individual members already cannot create or delete org-wide resources.** An org skill needs an org admin at the route (`routes/skills.ts:460-466`) and an org admin in `isAuthorizedFor`'s org arm for every write (`services/skills.ts:137-138`). An org content source needs an org admin to create (`routes/skills.ts:644-651`) and to delete, through the `isOrgAdmin` option threaded into `ownedContentSourceRow` (`routes/skills.ts:693-698`). An org credential needs `requireOrgAdmin` (`routes/credentials.ts:128-133`). An org-owned workflow is a repository mirror that nobody may edit or delete in the product, and arming one of its triggers needs an org admin (`armableDefinitionRow`, `workflows/service.ts:322-330`). The org tier is already the stricter tier the call asked for.

### The two gaps

A plain member may delete a team's locally authored workflows and skills. `deleteWorkflowDefinition` reaches its row through `ownedDefinitionRow`, whose team arm is `isTeamMember` (`workflows/service.ts:248`). `deleteSkill` reaches its row through `ownedSkillRow` and `isAuthorizedFor`, whose team arm is also `isTeamMember` (`services/skills.ts:136`). A team workflow can hold a schedule, a webhook and the team's credentials, and a team skill is loaded as trusted context into every member's session. Both are the shared property of the team.

Nothing in the repository models a pending request. `notifications` carries one row per recipient with a title, an href and a `read_at`, and no state that a decision could change (`packages/api/src/schema/index.ts:654-669`). `invites` is the closest shape, and it is single-use and keyed by a code hash (`schema/index.ts:303-313`).

### The rails that already exist

**Attention fan-out.** `routeAttention` is the only writer of `notifications` (`packages/api/src/orchestrator/attention.ts:203-234`). `resolveAudience` is a pure function: a team owner fans out to all members, and narrows to team admins only when the kind is `escalation` (`attention.ts:111-124`). That narrowing is exactly the audience a deletion request needs. The web bell already renders an unread item that carries an href and no session id, and treats it as an unscoped action (`packages/web/src/components/layout/notifications-bell.tsx:42`, `84`).

**Decision gates.** `DecisionGate` is the repo's approval primitive, and it is session-shaped. A gate carries `sessionId`, `threadId` and `queueItemId` in its identity (`packages/engine/src/types.ts:861-894`), a live in-process promise holds the waiting tool (`packages/engine/src/decision-gate.ts:67-118`), and resolving one runs through `POST /api/sessions/:id/decisions/:gateId/resolve` (`packages/api/src/routes/messages.ts:915`). A deletion request has no session, no thread and no blocked tool.

**Action policies.** `action_policies`, `runtime_grants` and `action_policy_overrides` decide whether an agent may perform a plugin action, keyed on `service` and `action_id`, with principals `org` and `user` (`schema/index.ts:1376-1465`). They do not model a person's one-off request about one row.

**Refusals that are not about permission.** Three exist, and they are already worded. A repository-mirrored workflow or skill refuses every edit and delete with 409 and names the file (`RepoOwnedWorkflowError`, `packages/shared/src/errors.ts:108-119`; the skill wording at `routes/skills.ts:563-567`). A workflow with an unsettled run refuses deletion until the run is cancelled (`workflows/service.ts:1013-1018`, route wording at `routes/workflows.ts:445-450`). A team refuses deletion while it mirrors a live identity-provider group or while `valet.yaml` declares it (`services/teams.ts:133-167`), and while any team-owned workflow has an unsettled run (`TeamHasActiveRunsError`, `services/teams.ts:77-86`).

### The existence-hiding convention, as the repository states it

`routes/teams.ts:172-179` writes the rule out in full: 403 means the caller's role is too low, 404 is reserved for cross-org and unauthorized callers where hiding existence is the point, and a 404 to a caller who can already see the resource is a lie that caller cannot act on. The current 404 on a member's delete is the second half applied where the first half belongs. A member of the team can already list the team's credentials (`canViewTeam`, `routes/credentials.ts:143-149`), its API keys (`routes/team-api-keys.ts:27-35` and `:79`), its content sources, its workflows and its skills. The resource's existence is disclosed to that member before the delete is attempted.

## Decisions

**1. The flow covers deletion only, and only for team-owned resources.** Creation and editing keep the gates they have. The call was explicit that anybody may create, and every create path above already agrees. Editing a team workflow or skill is reversible through version history (`workflow_versions`, `schema/index.ts:1162`) and through the repository for mirrored rows. Deletion is the one act with no undo, so it is the one act that gets a review step.

**2. Deleting a team workflow or a team skill becomes a team-admin act.** `deleteWorkflowDefinition` and `deleteSkill` keep reaching their row through the member-level read, then add a `canAdministerTeam` check when `row.ownerType === "team"`. This is the shape `deleteContentSource` already uses, one line after its own row read (`services/content-sources.ts:562-566`), and it is the shape that leaves list and read member-level. Without this change the call's headline is false for the two resources members care about most, and the flow this spec designs would have nothing to gate. The 2026-08-24 team credentials design made the same move for team content sources, for the same stated reason: one member should not be able to change what runs as the whole team.

**3. The flow accepts six resource types, and the type set is a table, not a switch.** A request names `resourceType` from `workflow | skill | content_source | credential | api_key | team`, plus a `resourceId`. A registry in one module maps each type onto three existing functions: the read predicate that decides whether the requester may see the resource, the admin predicate, and the delete function. Approval calls that delete function with the deciding admin as the actor. Nothing in this flow reimplements a delete, so `refuseRepoOwned`, the unsettled-run check, the ownership advisory lock and the mirrored-content cascade all still run, in the same order, under the same authority.

For `credential` the `resourceId` is the service name, which is the credential's identity inside a team (`credentials` is keyed on `(owner_type, owner_id, service)`, `schema/index.ts:1315`). For `team` the `resourceId` is the team id itself. Assistants, sessions and memory files are out of this pass; decision 14 says why.

**4. A request is a new row, in `team_deletion_requests`.** The three candidate rails were read and rejected for stated reasons. A decision gate cannot hold it: a gate is identified by a session, a thread and a queue item, it is answered by a live in-process promise, and this repository has already shipped a wedge where a gate that lost its waiter blocked its thread with no way out. An `action_policies` row cannot hold it: those rows authorize an agent's plugin action, and their principals are org and user. A `notifications` row cannot hold it: the table stores one row per recipient with no state a decision could write, so a request with three admins would be three rows and the first answer would leave two live.

The row is small:

| Column | Notes |
| --- | --- |
| `id` | `dreq_` prefix, so a request id can never collide with a gate id in the notification id space |
| `org_id`, `team_id` | tenancy and the approver audience |
| `resource_type`, `resource_id` | decision 3's registry key |
| `resource_label` | the resource's display name, snapshotted at submit, so a decided request stays readable after the resource is gone |
| `requested_by`, `reason`, `requested_at` | `reason` is optional and capped |
| `expires_at` | decision 8 |
| `status` | `pending`, `approved`, `declined`, `withdrawn` |
| `decided_by`, `decided_at`, `decision_note` | null while pending |
| `last_refusal` | decision 7 |

Two indexes: a partial unique index on `(team_id, resource_type, resource_id) where status = 'pending'`, which is decision 9, and `(team_id, status)` for the admin list. The table needs a `{ kind: "table" }` entry in `SCHEMA_REPAIRS` (`packages/api/src/lib/drizzle.ts:171`), or a deployed database never receives it.

**5. Delivery reuses the attention router, with one new kind.** Submitting a request calls `routeAttention` with `owner: { type: "team", id: teamId }`, `dedupeKey: requestId`, an href to the team's page, and no `sessionId`. The audience must be team admins only, and `resolveAudience` narrows a team owner to admins for exactly one kind today, `escalation` (`attention.ts:116-118`). Reusing `escalation` would make the bell read "Escalation" for a routine housekeeping ask, and would put the request into `NEEDS_ACTION`, which plays a sound (`packages/web/src/lib/use-attention-ping.ts:24`). So `AttentionKind` gains `review`, the admin-narrowing test becomes membership of a two-kind set, and `review` stays out of `NEEDS_ACTION`: a deletion request is a task, not an interrupt, and nothing is blocked while it waits. `KIND_LABEL` gains "Review" (`notifications-bell.tsx:24-29`). The per-kind opt-out in `user_notification_preferences` then works for the new kind with no further code.

`markGateNotificationsRead` marks a gate's notifications read by a `n-approval-{gateId}-` prefix match and its own comment asks any producer under another kind to extend it (`attention.ts:184-194`). It is generalized to take the kind and the dedupe key, so deciding a request marks the admins' rows read the same way answering a gate does. The gate caller passes `"approval"` and keeps its behavior.

**6. A member who is refused sees 403 and the request, not 404.** When the caller is a live member of the team, every delete path in decision 3's table answers 403 with a body that carries `code: "team_admin_required"`, the `teamId`, and the id of the open request when one exists. A caller who is not a member of that team, and any cross-org caller, keeps the 404 they get today.

This is a deliberate exception to existence hiding, and it is safe because it discloses nothing. The member could already list the resource through the read routes named in the Context. The 403 body repeats no resource name back to the caller. And the convention already carves this case out in its own words at `routes/teams.ts:172-179`: 404 is for unauthorized callers, and a 404 to somebody who can see the thing is a lie they cannot act on. The change makes the code match the rule it already wrote down.

The message names the corrective action: "Only a team admin can delete this. Open a deletion request, and a team admin approves or declines it." When a request is already open: "A deletion request for this is already open. A team admin decides it."

**7. A permanent refusal stops the request at the door. A temporary refusal stops the approval, and the request stays open.** The two classes are different and must not be flattened.

A permanent refusal is one no admin can clear, so a request would be theatre. Submitting against a repository-mirrored workflow or skill returns the existing 409 unchanged: `RepoOwnedWorkflowError`'s message already tells the requester to edit the file and push (`packages/shared/src/errors.ts:113-115`), which is a fix the requester can perform themselves. Submitting a `team` request for a live identity-provider mirror or a `valet.yaml` team returns the message `idpManagedTeamMessage` or `ConfigManagedTeamError` already produces (`services/teams.ts:102-117`, `:156-167`). No row is written in either case, and no admin is notified.

A temporary refusal is one that clears on its own or that an admin can clear. A workflow with an unsettled run, and a team whose workflows hold one, are both temporary. The request opens normally. On approve, the delete function raises its own refusal, the route returns that refusal verbatim so one wording covers both paths, and the server records it in `last_refusal` and leaves the request pending. The admin sees why the approval did not land, in the list, without clicking again.

**8. A request expires after 14 days, and expiry is read, not swept.** `expires_at` is stamped at submit. A pending row past `expires_at` reads as expired everywhere: the list renders it expired, approve and decline refuse it, and the partial unique index no longer blocks a fresh request because the resubmission path closes the stale row to `declined` with a server-written note in the same transaction that inserts the new one. No timer and no background sweep runs, which keeps this out of the territory CLAUDE.md's invariant rule covers. Fourteen days covers a two-week absence and keeps a stale list short. The wording when a requester tries to act on one: "This deletion request expired on {date}. Open a new request if the resource should still be deleted."

**9. A second request for the same resource joins the first.** The partial unique index makes one open request per `(team, resourceType, resourceId)` a database fact, not a convention. A duplicate submit returns 200 with the open request, names its requester and its time, and sends no second notification. Two notifications for one decision teaches an admin to ignore the bell, and two rows would let one admin approve while another declines the same resource. The second requester's reason is not recorded; the first reason is the one the admin reads.

**10. The requester may withdraw. Any team admin may decide. A team API key may do neither.** Withdraw is the requester alone, because the request is theirs. Approve and decline run `canAdministerTeam`, which also admits an org admin off the team, exactly as every other team administration gate does, and for the same recovery reason that function documents. All four writes call `refuseTeamApiKey` (`routes/teams.ts:243-250`): the point of the flow is that a person decides, and a team key carries the minting admin only for audit.

**11. The requester leaving the team does not close the request.** Approval executes the delete under the deciding admin's own authority, so the requester's membership is not part of the authorization at decision time. The list marks a requester who is no longer a member, so the admin can weigh that before deciding. Auto-declining on removal would need a hook in `removeMember` (`services/teams.ts:474`), a second in the identity-provider sync, which writes `team_members` directly and never calls the guarded functions (`services/teams.ts:129-131`), and would still miss a requester who left the org, because no path removes team memberships when an org membership ends. A hook that must be added in three places and can be forgotten in one is worse than visible state an admin can read. This follows the same reasoning the 2026-08-24 team credentials design gave for leaving a broken delegation visible rather than deleting it eagerly.

**12. Deleting the team deletes its requests.** `deleteTeam` already removes every team-owned row inside its transaction, because a surviving row would sit in the table with no owner who can reach it (`services/teams.ts:735-766`). One more delete goes in the same list. The rows are housekeeping state, not history anybody audits.

**13. The web surface is the team's own page, and the Delete button changes label, not place.** `packages/web/src/routes/settings.organization.teams.tsx` already hosts the panel, and it is already open to every org member. A member sees the same Delete control an admin sees, labelled "Request deletion", instead of the control being hidden by `canMutate` as it is today (`packages/web/src/components/settings/teams-panel.tsx:322-347`). The expanded team gains a "Deletion requests" block beside the credentials and 1Password blocks, listing open requests with the requester, the reason, the age, any recorded refusal, and Approve and Decline for an admin. `TeamSummary.callerRole` already tells the client which one to render (`packages/api/src/wire/types.ts:1705`), so no new field carries the role.

**14. Assistants, sessions, memory files and the 1Password lease stay out of this pass.** All four are already admin-gated, so no member can delete them today and nothing is broken. A session is not a document: destroying one tears down an engine session and a sandbox, which is the kind of act an admin performs while watching it, not one they approve from a list. A memory file and a lease are small enough to restore by hand. Adding them later costs one registry entry each, which is the point of decision 3's table.

## Implementation plan

Each task is one commit. Schema edits go into `packages/api/migrations/pg/0000_app.sql` in place, then `make dev-clean` in every worktree that holds dev data.

1. **Schema.** Add `teamDeletionRequests` to `packages/api/src/schema/index.ts`, the same table to `0000_app.sql` with both indexes, and a `{ kind: "table" }` repair to `SCHEMA_REPAIRS` in `packages/api/src/lib/drizzle.ts`. Extend `packages/api/src/schema/pg-schema.test.ts` so the partial unique index refuses a second pending row and admits one after the first is decided.

2. **Tighten the two delete gates.** Add the `canAdministerTeam` check for a team-owned row to `deleteWorkflowDefinition` (`workflows/service.ts:1003-1022`) and `deleteSkill` (`services/skills.ts:644-657`), and widen both result unions with `team_admin_required`. Change `deleteContentSource` (`services/content-sources.ts:554-575`) from a boolean to the same union so all three report the refusal the same way. Update the three call sites in `routes/workflows.ts:441-452`, `routes/skills.ts:559-570` and `routes/skills.ts:693-698`. Extend the existing suites so a member is refused and an admin is not.

3. **The registry and the service.** Create `packages/api/src/services/team-deletion-requests.ts` holding decision 3's registry and `submitRequest`, `listRequests`, `approveRequest`, `declineRequest` and `withdrawRequest`. Approval calls the registry's delete function; it never touches a resource table itself. Cover the permanent and temporary refusal split from decision 7, the duplicate join, expiry at read, and a requester who has left the team.

4. **Attention.** Add `review` to `AttentionKind`, replace the `kind === "escalation"` test in `resolveAudience` with a two-kind admin set, and generalize `markGateNotificationsRead` into a kind-plus-key form with the gate caller passing `"approval"`. Extend `packages/api/src/orchestrator/attention.test.ts` so a `review` event on a team owner reaches admins only.

5. **Routes.** Add `/api/teams/:id/deletion-requests` with list, submit, approve, decline and withdraw, all behind `refuseTeamApiKey`. Return decision 6's 403 body from the five delete sites: `routes/workflows.ts`, `routes/skills.ts` for stored skills and for sources, `routes/credentials.ts` and `routes/team-api-keys.ts`, plus `DELETE /api/teams/:id`. Assert in tests that a non-member still receives 404 at every one of them.

6. **Wire and web.** Add the request types to `packages/api/src/wire/types.ts`, the `review` kind to `NotificationKind`, and "Review" to `KIND_LABEL`. Add the deletion-requests block and the member Delete label to `packages/web/src/components/settings/teams-panel.tsx`.

7. **Sweep.** `pnpm typecheck`, then `make e2e` with a clean scorecard.

## Testing

Five assertions carry the signal.

A plain member's delete of a team workflow returns 403 and names the request, and the same call from a non-member of that team returns 404. This is the whole of decision 6 in two requests.

Approving a request runs the real delete: a repository-mirrored workflow never reaches an open request, and a workflow with an unsettled run leaves the request pending with the run refusal recorded.

A second submission for one resource returns the first request and writes no second notification row.

A `review` event for a team owner produces notification rows for the team's admins and for nobody else.

A requester removed from the team leaves the request answerable, and approving it still deletes the resource.

## Non-goals

- Any org-level approval flow. Org resources are already org-admin-only on every path in the Context table, and the call put them in a stricter tier.
- Changing who may create or edit anything.
- A permission vocabulary. `isTeamMember` and `canAdministerTeam` stay the two gates, for the reason the 2026-08-24 team credentials design gives.
- Approval for team membership changes. Those are people, not resources.
- Requests for assistants, sessions, memory files and the 1Password lease. Decision 14.
- A second channel for the request. Slack and Telegram deliverers already ride `routeAttention`'s channel list, and whether they should carry this kind is a delivery question, not a design question for this flow.

## Open questions

1. **Should a member be able to delete a team resource they authored themselves?** Neither `skills` nor `workflow_definitions` records an author (`schema/index.ts:994-1018` and `:1128-1157`); only `content_sources` has `created_by`. An author carve-out therefore needs a new column on two tables and a second definition of "may delete", beside `canAdministerTeam`. This spec proposes no carve-out. Product decides whether undoing your own mistake without an admin is worth the column.

2. **Should an org admin who is not on the team receive the notification?** They may decide a request, because `canAdministerTeam` admits them, but `fetchMembership` reads `team_members` only for a team owner (`attention.ts:127-134`), so they will never be told one is waiting. Extending the fan-out means every org admin hears about every team's housekeeping. The tech lead decides which of the two costs is worse.

3. **Is 14 days the right expiry?** The call set no number. Decision 8 proposes 14 days and the mechanism does not depend on the value. The tech lead confirms it.

4. **Should a repeated request after a decline be limited?** Today a member may re-open a request the moment an admin declines it. Nobody raised this on the call. The tech lead decides whether a decline should hold for a period, and if so how a member learns when they may ask again.

5. **Does a decline need a reason?** `decision_note` exists and is optional in this design. Whether the UI requires it on decline, on approve, or on neither, was not settled.


## Implementation and verification notes (2026-09-11)

The request form uses the shared `SelectMenu` and exposes only resource labels and
IDs. Team changes reset the form and close any confirmation. Losing admin access
closes a pending approval or decline. Errors leave a request retryable and do not
claim that deletion succeeded. The confirmation explains the team-wide effect
before an admin approves.

Every request write and team-resource deletion takes the team's ownership lock,
then locks the current organization and team membership rows with `FOR SHARE`.
Authorization uses the roles returned by those locked reads. It does not rescan
membership afterward: a row inserted after a missing-row read would not be
protected against revocation. An organization admin can decide without team
membership, but an organization membership row is required. A team member is
admitted to requests and receives a 403 on direct deletion; strangers receive 404.

The implementation retains the proposed defaults: requests expire after 14 days,
notes are optional, there is no author exception, and notifications go to team
admins only. Organization admins can decide without receiving that fan-out.
Delivery is web-only; this flow sends no Slack or Telegram messages.

Regression coverage includes captured-role authorization, duplicate submissions,
expiry, withdrawal, competing decisions, departed requesters, temporary deletion
refusals, secret-free target summaries, team cleanup, UI role changes, team
switching, empty/error states, confirmation, and retry. Lock-race unit tests use
a controlled query driver; they do not substitute for a multi-connection Postgres
concurrency run. Browser verification uses disposable local data and no providers.

### Browser verification (2026-09-11)

Verified with CUA against this worktree's web app and real API on a disposable
local database: a member selected a skill through the styled resource menu,
submitted a reason, and saw a pending request with Withdraw but no approval
controls. After promoting the fixture member and reloading, Approve and Decline
appeared. The approval dialog showed the irreversible action and optional note.
Approval retained the request as approved with the note and removed the skill
from the resource picker after query invalidation. No real provider resources,
credentials, or messages were used. Full integrated E2E remains with the
consolidated branch.

The final independent review added three regression cases: stale organization
membership cannot read requests or target labels; team deletion retires all
associated review notices in its transaction; and a team API key receives 404
for another team's workflow deletion without learning team or request IDs.
Own-team machine deletion remains refused, and request management requires a
person. Existing organization-admin recovery remains available.

### Consolidated-branch integration

TKAI-442 adds durable workflow-source invalidation, which is absent from this
source branch. When integrating, import `invalidateWorkflowSources` from
`./content-sync/invalidation.js` into `services/team-resource-deletion.ts` and add
`await invalidateWorkflowSources(tx, { teamId })` immediately after
`await tx.delete(credentials).where(where)` inside `deleteTeamCredential`.
Both direct deletion and request approval call this helper. Keep the existing
post-commit resync; it does not replace transactional invalidation. Verify that
both deletion paths increment `syncRevision`, clear `discoveryScan` and
`lastManifestHash`, and make the source due without relying on post-commit
resync. Verify that rollback preserves credentials and their source state.

TKAI-430 intentionally reserves destructive team-resource approval for people.
A team API key cannot delete even its own workflow. Align TKAI-445's authority
documentation and any UI claims with that rule when integrating; other-team
and personal workflows remain hidden with 404.

The TKAI-445 API-key description should say: “These keys can read, run, and
change this team’s sessions and workflows, and delete sessions, subject to
resource guards. Workflow deletion requires a person with team administration
access.” Update its UI assertion and the Authority copy section in
`docs/specs/2026-09-04-team-api-keys-design.md` during integration.

Credential removal and `invalidateWorkflowSources(tx, { teamId })` commit together for direct and approved deletion. If the refresh cannot persist, neither the credential deletion nor the approval commits. Route-level regressions cover rollback and retry on both paths.
