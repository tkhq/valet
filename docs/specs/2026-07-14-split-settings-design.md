# Split Settings — Design Spec

> A settings shell for the v2 web app (`packages/web` + `packages/api`) that splits the surface into **You** (per-user) and **Organization** (org-admin-gated, feature-gated) halves, replaces the current single flat `/settings` page, wires the dormant `org_members.role` column into real authz, and ships the first teams management UI over the existing teams API.

## Scope

Covers: the `/settings` layout shell and all sub-routes; user sections (profile, assistant identity, appearance, notifications); org sections (general, members, teams); the organizations feature gate; new `/api/me` and `/api/org*` routes; the `requireOrgAdmin` authz helper and its adoption by `teams.ts`.

Does NOT cover: real login / identity providers (auth design pass, separate); invites and member removal (meaningless until login exists); billing; org-level integrations/credentials (`/integrations` stays per-user and stays a sibling page); avatar file upload (URL field only this phase).

## Background (what exists today)

- `/settings` (`packages/web/src/routes/settings.tsx`, 136 lines) is one flat page: a hand-rolled theme radiogroup + four notification toggles. Nothing else.
- Assistant name/personality editing lives only on the dashboard (`IdentityStep`/`IdentityHeader` over `PATCH /api/orchestrator/info`).
- The api has a complete teams router (`packages/api/src/routes/teams.ts`: CRUD, membership, roles) with **zero UI**.
- `org_members.role` (`admin|member`) exists in the schema but is dead: every "org admin" check actually reads the global `users.role`. Local dev (`VALET_LOCAL_AUTH=1`) runs as `local-user`, seeded as an org-member admin of the single `local-org`.
- Web conventions: TanStack file routes (nested via dot segments), calm-companion tokens (paper/ink/moss/amber, Newsreader display face), primitives in `src/components/primitives/` (no Tabs — and this design needs none).

## Decisions

1. **Sidebar settings shell**: `/settings` becomes a layout route with a left rail; each section is its own nested route. No Tabs primitive.
2. **Organizations are feature-gated**: a new flag on `orgs` controls whether the Organization group exists in the UI. Solo users see an enable card instead of org chrome.
3. **`org_members.role` becomes real**: new `requireOrgAdmin` helper; new org routes use it; `teams.ts`'s global-admin shortcut switches to it.
4. **Provisioning rule**: whoever creates an org is its admin. Today that means the seeded `local-user` is admin; the future auth phase inherits the rule for first login.
5. **Assistant identity is shared, not duplicated**: settings reuses the dashboard's identity editing components (extracted), both over `PATCH /api/orchestrator/info`.
6. **Visual language extends calm-companion**: no boxes-in-a-void; card-less stacks with hairline separators, quiet rail, moss active accent, Newsreader headings. Implementation uses the frontend-design skill.

## Routes & navigation

```
/settings                    → redirect to /settings/profile
/settings/profile            YOU · Profile
/settings/assistant          YOU · Assistant
/settings/appearance         YOU · Appearance
/settings/notifications      YOU · Notifications
/settings/organization       ORGANIZATION · General      (admin + gate)
/settings/organization/members   ORGANIZATION · Members  (admin + gate)
/settings/organization/teams    ORGANIZATION · Teams     (admin + gate)
```

- The rail shows two small-caps groups: **You** (always) and **Organization** (only when the feature gate is ON **and** the caller is an org admin). Members never see the group — hidden, not disabled.
- With the gate OFF and the caller an org admin, the rail bottom shows the **enable card** ("Working with a team? Enable organizations") in place of the group.
- Direct navigation to an org route without gate+admin renders a quiet empty state ("Organization settings are managed by your org admins" / "Organizations aren't enabled" respectively) — never a crash, never a redirect loop.
- `/integrations` is unchanged and stays in the top nav. The top-nav gear keeps linking to `/settings`.

## Feature gate

- Schema: `orgs` gains `features` (TEXT, JSON object, default `'{}'`), edited into `0000_talented_medusa.sql` in place per the pre-1.0 rule (`rm ~/.valet/app.db` after). Gate key: `organizations: boolean` (absent = false).
- `GET /api/org` returns `features.organizations`; `PATCH /api/org` accepts `{ features: { organizations } }` (org-admin only).
- Enable card (user settings, org admins, gate off) → `PATCH /api/org {features:{organizations:true}}` → rail group appears, navigate to `/settings/organization`.
- Disable lives in Organization → General ("Turn off organization features") — hides the group again; **no data is deleted** (teams/members persist dormant).
- API enforcement: org routes other than `GET/PATCH /api/org` itself return 404 `{error:"organizations not enabled"}` when the gate is off (the gate toggle must always be reachable by admins). Teams routes stay reachable (existing API contract unchanged); the gate is a UI-surface gate plus the org-member/team routes above.

## Sections — content and controls inventory

Every control enumerated (surfaces alone are not a spec).

### You · Profile
- Display name: text input, Save button (disabled until dirty) → `PATCH /api/me {name}`.
- Avatar URL: text input with live preview circle, saved with the same Save → `PATCH /api/me {avatarUrl}`.
- Email: read-only row with hint "Sign-in email — managed by your login once real auth ships."
- Data: `GET /api/me`.

### You · Assistant
- Assistant name: text input (writes `orchestrator_identities.handle`).
- Personality: multiline editor (writes `assistant/personality.md` memory file).
- One Save per field-group, both via existing `PATCH /api/orchestrator/info`; loading/saving/error states as on the dashboard. Components extracted from `IdentityStep` so dashboard and settings share one implementation.

### You · Appearance
- Theme: three radio-cards (System / Light / Dark) over the existing `~/lib/theme.ts` client-side mechanism. New `radio-card` pattern component in primitives.

### You · Notifications
- Four per-kind toggles (notification / question / escalation / approval), existing `GET/PUT /api/notifications/preferences`. Restyled into the new section layout; behavior unchanged.

### You · (conditional footer)
- Enable-organizations card: title, one-line description, "Enable" button → PATCH gate → toast/refresh. Visible only when (org admin && gate off).

### Organization · General
- Org name: text input + Save → `PATCH /api/org {name}`.
- Org id, created date: read-only rows.
- "Turn off organization features": quiet destructive-adjacent button with confirm dialog (copy states nothing is deleted) → `PATCH /api/org {features:{organizations:false}}` → navigate back to `/settings/profile`.

### Organization · Members
- Member list: avatar, name, email, role badge, joined date — `GET /api/org/members`.
- Role select per row (admin | member) → `PATCH /api/org/members/:userId {role}`; optimistic update with rollback on error.
- Last-admin guard: server rejects demoting the only admin (400 `{error:"an organization needs at least one admin"}`); UI disables the control on the sole admin row with a tooltip.
- Footer note: "Invites arrive with real login." No invite/remove controls this phase.

### Organization · Teams
- Team list: name, member count, created date — `GET /api/teams` (existing).
- New team: name input + Create button (existing `POST /api/teams`); inline validation on duplicate name (409 from api).
- Per-team expandable panel: member rows (name, role badge), role toggle (existing `PATCH /api/teams/:id/members/:userId`), Remove member (existing `DELETE`), Add member (select from org members not yet in team → existing `POST /api/teams/:id/members`).
- Delete team: per-team overflow menu → confirm dialog → existing `DELETE /api/teams/:id`.

## API additions (`packages/api`)

| Route | Method | Authz | Behavior |
|---|---|---|---|
| `/api/me` | GET | user | `{id, email, name, avatarUrl, role, orgId, orgRole}` |
| `/api/me` | PATCH | user | update `name`/`avatarUrl` on `users` |
| `/api/org` | GET | org member | `{id, name, createdAt, features, callerRole}` |
| `/api/org` | PATCH | **org admin** | update `name` and/or `features.organizations` |
| `/api/org/members` | GET | org admin + gate | member rows joined `users` × `org_members` |
| `/api/org/members/:userId` | PATCH | org admin + gate | set `org_members.role`; last-admin guard |

- **`requireOrgAdmin(db, orgId, userId)`** helper (new, in api services or middleware): reads `org_members.role === "admin"`. Used by the routes above; `teams.ts`'s `canMutateTeam` swaps its `user.role === "admin"` shortcut for it. `users.role` remains the *global operator* gate for `/api/admin` only.
- Wire types added in `wire/types.ts` per convention; route tests per existing colocated patterns (incl. member-cannot-PATCH-org, last-admin 400, gate-off 404).

## Web architecture

- `routes/settings.tsx` becomes the layout (rail + `<Outlet/>`); sections at `routes/settings.profile.tsx` etc.; org sections `routes/settings.organization*.tsx`. Route-adjacent tests per `-*.test.tsx` convention.
- New components under `components/settings/`: `settings-rail.tsx`, `section.tsx` (heading + description + children stack with hairline separators), `field-row.tsx`, `radio-card.tsx` (promoted to primitives if reused), `enable-org-card.tsx`, `members-table.tsx`, `teams-panel.tsx`.
- Data layer: `src/api/settings.ts` query-key factories (`me`, `org`, `orgMembers`) alongside existing `teams` usage; mutations invalidate their keys; the rail's org-group visibility derives from the `GET /api/org` query (cached, so no flash — render the group skeleton-less, appearing on data).
- The dashboard's `IdentityStep` internals are extracted to `components/assistant/identity-fields.tsx` consumed by both dashboard and `/settings/assistant`.

## Visual direction (implementation via frontend-design skill)

Calm-companion, extended: page title and section headings in Newsreader; rail with small-caps group labels, moss text accent + soft moss-wash pill on the active item; content pane a single max-w-2xl column; sections as open stacks separated by hairlines (`line` token) — **no card boxes**; inputs on paper with hairline borders; Save buttons quiet (moss) and only visible-enabled when dirty; the enable-organizations card is the one intentionally-boxed element on the user side (it's an invitation, not a setting). Empty/edge states written in the product's plain first-person-adjacent voice.

## Error handling

- All mutations: inline error text under the control (existing pattern), no toasts-only failures.
- Org routes: 403 (not admin), 404 (gate off) mapped to the quiet empty states above.
- Optimistic role changes roll back on error; last-admin guard is server-authoritative (UI disable is a courtesy).

## Testing

- API: route tests for every new route (authz matrix: member vs admin; gate on/off; last-admin guard; me PATCH field whitelist). `teams.ts` authz-swap regression: a non-admin org member with team-admin rights can still mutate their team; a plain member cannot.
- Web: route-adjacent component tests — rail renders gate-aware groups; each section renders and submits its mutation (msw/fetch-mock per existing patterns); org empty states for member/gate-off.
- Manual dogfood: enable gate → rename org → flip a member role (via test-header second user) → create team → add member → theme + notification toggles still work → disable gate.

## Provisioning rule (for the auth phase, stated now)

Creating an org makes the creator its `org_members.role = "admin"`. First login (when real auth ships) implicitly creates the user's org and therefore makes them admin. Local dev already seeds `local-user` as admin of `local-org` — the enable card is visible on first boot.
