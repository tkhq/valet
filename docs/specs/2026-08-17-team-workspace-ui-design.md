# Team workspace UI

Status: Implemented 2026-08-17.

## Problem

The API owns a complete team model: sessions, assistants, workflows,
skills, memory, and event subscriptions carry an owner, and every route
checks team membership. The web UI shows almost none of it. The
workspace switcher exists, but pages do not say which workspace they
show, create flows ignore the switcher, and two surfaces mislabel team
ownership. A user cannot tell that resources are owned differently.

## Thesis

A workspace is a place, not a filter. One rule, applied everywhere:

> Everything below the switcher belongs to the active workspace. Every
> page says so, everything you create is born there, and anything that
> varies is badged.

The design adds no new controls. It makes the one existing control —
the switcher — legible and trustworthy.

## Decisions

1. **The workspace clause.** One shared grammar names the active
   workspace: a quiet clause in every scoped page header ("in
   Engineering — shared with 4 people") and in every create dialog
   ("Creates in Engineering. Everyone on the team can see it."). One
   component (`workspace-context.tsx`), one voice. Empty states use the
   same words ("No sessions in Engineering yet").

2. **No badges inside a scoped list.** A scoped list holds one owner's
   rows by construction, so a per-row badge repeats the header. Badges
   appear only where ownership varies within one view: the events
   subscriptions list, the personal skills catalog, and a session
   detail page reached from another scope (notification, shared link).
   `OwnerBadge` stays the single badge idiom.

3. **Creation inherits the workspace.** `NewSessionDialog` reads the
   scope and sends `teamId`, exactly as `new-workflow-dialog` already
   does. No owner dropdown in the form — the switcher answered that
   question. The dialog states the answer instead.

4. **One name for one thing.** "Workspace" now names the switcher
   scope. The new-session field previously labeled "Workspace path"
   (the in-sandbox path) is relabeled "Working directory". UI copy in
   events says "assistant", not "orchestrator" — the term every other
   surface uses.

5. **Sessions can move between workspaces.** `PATCH /api/sessions/:id`
   accepts `teamId?: string | null` — a team id moves the session to
   that team (caller must administer the session and be a member of the
   target team); `null` moves it to the caller's personal workspace.
   The session header gains "Move to workspace…". This is also the
   migration path: before this pass, the UI could only create personal
   sessions, so team workspaces look empty.

6. **The switcher never lies.** Selecting a team whose assistants lack
   an `isDefault` row used to create a duplicate assistant; the
   switcher now falls back to the team's first assistant. A failed
   assistant create used to silently revert the selection; the failure
   now shows below the nav.

7. **The usage dashboard follows the switcher.** Amended 2026-08-27
   (TKAI-226). A team workspace pins `/usage` to `scope=team&teamId=`,
   which the usage endpoints (`/breakdown`, `/items`, `/export.csv`)
   answer with the team's owned spend (`cost_entries.owner_type =
   'team'`) after resolving the team in the caller's org
   (`getTeamInOrg`) and a live `isTeamMember` check. An unknown team, a
   foreign org's team, and a team the caller is not on all answer the
   same 404 — the existence-hiding convention the sessions, teams, and
   events routes use. The me/org toggle, the proxy request log, and
   the key-setup callout are personal surfaces: proxy traffic is never
   team-owned, so they render only in the personal workspace. The proxy
   drill-down returns no rows in team scope for the same reason. Team
   scope shows no per-member data — `byUser` stays an org-admin view,
   and the team CSV blanks `user_id` so a member cannot reconstruct it.
   The page holds its queries until the switcher's stored key is
   validated against the team list, so a stale key from a team the
   caller left cannot flash a 404 in place of the totals.

8. **`/chat` follows the switcher too.** Added 2026-08-29. Arriving at
   `/chat` with no `?assistant=` used to open your PERSONAL default, even
   when the switcher named a team — so switching to a team on another page
   and then opening chat showed personal threads until you clicked the
   team's assistant. The page now opens the ACTIVE workspace's default
   assistant (`scopedDefaultAssistant`), and canonicalizes the URL to it
   under a team scope, so the sidebar highlight, the shared-with notice, and
   the threads all match the switcher. A team that owns no assistant keeps
   the personal fallback. The rail's thread tree resolves the same way.

9. **A team assistant's child runs nest under it.** Added 2026-08-29.
   `GET /api/orchestrator/children` used to resolve only the CALLER's
   personal default assistant, and the chat thread tree showed children for
   that one assistant alone. A child spawned by a team assistant — e.g. a
   team worker trigger's `task` — was therefore invisible: excluded from the
   standalone Sessions list AND nested under no thread tree. The endpoint now
   takes `?sessionId=` to scope children to any assistant the caller can view
   (`canViewChildrenOf`, authorized off the assistant's owner so a team member
   reaches a team assistant), and the thread tree passes the open assistant's
   session id. Dismiss authorizes the same way.

## Known limits

An adversarial review (2026-08-17) confirmed four limits this pass ships
with. All four predate it or extend documented contracts; they are
listed so the next pass starts here.

1. **Sandbox-facing routes authorize on `agentSessions.userId`, not the
   owner.** `POST /:id/sandbox-jwt`, `POST /:id/sandbox/replace`, the
   gateway proxy, and the channels gate callback all check the userId
   column only. This predates the move feature (team assistants already
   had owner ≠ userId), but a move makes it common for standalone
   sessions: team members cannot replace a moved session's sandbox, and
   the original creator keeps sandbox access after leaving the team.
   Fix belongs in `session-access.ts` consumers, not per-route patches.
2. **A personal take rebinds the sandbox identity.** The userId re-stamp
   that gives the mover admin rights also makes the next engine build
   resolve git/GitHub credentials as the mover. That is usually what
   "taking a session" should mean; it is a surprise when the mover lacks
   access to the bound repos.
3. **Open WebSockets survive a move.** `canViewSession` runs at
   handshake only — the same "drops access on the next reconnect"
   contract that team-leave has. A viewer with the session open keeps
   streaming until reconnect.
4. **The move's busy gate has a small TOCTOU window.** A submission
   admitted between the unsettled-check and the cache eviction runs on
   the evicted session. The same window exists on the profile path; a
   store-level guard would close both.

## Out of scope (deferred)

- **Team credentials and delegation** — Phase A of the team-resources
  design (commit 5feeb49c; the spec file is not in this tree — land it
  with the implementation). Needs its own backend pass.
- **Skills catalog asymmetry** — the personal workspace shows a union
  (yours + teams + org) while team workspaces pin. Fixing it needs a
  server-side "workspace + org" scope; until then the union view keeps
  its badges (decision 2).
- **Moving workflows and skills between workspaces** — same shape as
  decision 5; add when asked for.
- **Events feed scoping** — amended 2026-08-24 (small-fixes design,
  decision 2). The feed still lists org-level facts, not owned rows, and
  `GET /api/events` still answers with the whole org when it gets no
  owner. The page filters to the active workspace on first load instead:
  its scope control starts at "This workspace" and sends the switcher's
  owner, which narrows the feed to events delivered to that workspace's
  subscriptions and to the org's own, and "All" drops the owner again. The
  two owner sets match on purpose: the subscriptions list carries the same
  union, and the tabs are read side by side. The choice lives in the
  route's `?scope=` search param, because the two tabs unmount each other.
  The scoped feed also looks back 30 days only, which the page states; the
  owner filter rejects rows no index can pre-select, so without a bound one
  empty page walks the org's whole event history. The org-wide view stays
  one click away, and unbounded, because an event that matched nothing you
  own is the row you open when your subscription never fired. The
  subscriptions list, in the same change, scopes to the switcher's owner
  plus every org-owned row: an org-owned subscription belongs to no single
  workspace, and a row that appeared in none of them could never be
  disabled from the page that created it.
