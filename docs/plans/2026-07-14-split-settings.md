# Split Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat `/settings` page with a rail-navigated shell split into You (profile, assistant + default model, appearance, notifications) and Organization (general, members, teams — org-admin + feature-gated) halves, per `docs/specs/2026-07-14-split-settings-design.md`.

**Architecture:** Thin new API surface (`/api/me`, `/api/models`, `/api/org*`) over existing tables plus two new columns; a `requireOrgAdmin` helper makes `org_members.role` real authz; the web side is a TanStack nested-route shell with shared section/field primitives, reusing the dashboard's identity components and pi-ai's static model registry.

**Tech Stack:** Hono routes + Drizzle (packages/api), TanStack Router/Query + Tailwind calm-companion tokens (packages/web), pi-ai `getModels`, vitest.

## Global Constraints

- Spec is normative: `docs/specs/2026-07-14-split-settings-design.md` — read it before your task; its Decisions and controls inventory bind.
- Pre-1.0 migrations: edit `packages/api/migrations/0000_talented_medusa.sql` IN PLACE + mirror `packages/api/src/schema/index.ts`. NO new migration files. `rm ~/.valet/app.db` after schema edits.
- Type safety: no `any`, no `as unknown as T`, no `@ts-ignore`.
- Authz vocabulary: `users.role` = global operator (only `/api/admin` uses it); `org_members.role` = org admin (everything org-scoped here uses it).
- Feature gate: `orgs.features` JSON, key `organizations` (absent = false). `GET/PATCH /api/org` are always reachable by the right roles; all OTHER org routes 404 `{error:"organizations not enabled"}` when the gate is off.
- Copy rules (exact strings): last-admin guard error `"an organization needs at least one admin"`; member empty state `"Organization settings are managed by your org admins"`; gate-off empty state `"Organizations aren't enabled"`; members footer `"Invites arrive with real login."`; default-model helper `"New conversations start on this model; you can still switch per-thread in the chat header."`
- Visual work (Tasks 5–7): implementers MUST invoke the frontend-design skill; the spec's "Visual direction" section governs (Newsreader headings, hairline stacks, NO card boxes except the enable-org card, moss active accents).
- Web tests are route-adjacent `-*.test.tsx` files per existing convention; api tests colocated `.test.ts`.
- ENVIRONMENT: every Bash invocation starts with `source ~/.nvm/nvm.sh && nvm use && `. Known flakes to ignore: api `messages.abort.test.ts`; workspace-plugin `docs.find_text_index` classification test.
- Commits: terse, no AI mentions.

## File Structure

```
packages/api/
  migrations/0000_talented_medusa.sql        # MODIFIED: orgs.features, users.default_model
  src/schema/index.ts                        # MODIFIED: mirror columns
  src/services/org.ts                        # NEW: requireOrgAdmin, getOrgFeatures, org member queries, last-admin guard
  src/routes/me.ts                           # NEW: GET/PATCH /api/me
  src/routes/models.ts                       # NEW: GET /api/models
  src/routes/org.ts                          # NEW: GET/PATCH /api/org, GET/PATCH /api/org/members
  src/routes/teams.ts                        # MODIFIED: canMutateTeam org-admin swap
  src/engine/host.ts                         # MODIFIED: user default-model threading
  src/app.ts (or wherever routers mount)     # MODIFIED: mount me/models/org
packages/web/src/
  routes/settings.tsx                        # REWRITTEN: layout (rail + Outlet)
  routes/settings.index.tsx                  # NEW: redirect → /settings/profile
  routes/settings.profile.tsx … settings.notifications.tsx        # NEW: You sections
  routes/settings.organization.tsx (+ .members.tsx, .teams.tsx)   # NEW: Org sections
  components/settings/{settings-rail,section,field-row,radio-card,enable-org-card,model-combobox,members-table,teams-panel}.tsx  # NEW
  components/assistant/identity-fields.tsx   # NEW: extracted from identity-step.tsx
  api/settings.ts                            # NEW: query keys + fetchers (me, org, orgMembers, models)
```

---

### Task 1: Schema columns + `requireOrgAdmin` + teams authz swap (api)

**Files:**
- Modify: `packages/api/migrations/0000_talented_medusa.sql`, `packages/api/src/schema/index.ts`, `packages/api/src/routes/teams.ts` (`canMutateTeam`, ~lines 90-102)
- Create: `packages/api/src/services/org.ts`, `packages/api/src/services/org.test.ts`

**Interfaces:**
- Produces (Tasks 3–4 rely on these exact exports from `services/org.ts`):
  - `isOrgAdmin(db: AppDb, orgId: string, userId: string): Promise<boolean>` — reads `org_members.role === "admin"`.
  - `getOrgFeatures(db: AppDb, orgId: string): Promise<{ organizations: boolean }>` — parses `orgs.features` JSON, absent key → false.
  - `setOrgFeatures(db, orgId, features)` / `renameOrg(db, orgId, name)`.
  - `listOrgMembers(db, orgId): Promise<Array<{userId; email; name: string|null; avatarUrl: string|null; role: "admin"|"member"; joinedAt: number}>>` (join `org_members` × `users`; `joinedAt` = `users.created_at` fallback if org_members has no timestamp — check the table; if `org_members` lacks a created_at column, ADD one in the same 0000 edit, default to now for the seed).
  - `setOrgMemberRole(db, orgId, userId, role): Promise<{ok: true} | {ok: false; error: string}>` — returns `{ok:false, error:"an organization needs at least one admin"}` when demoting the sole admin (count admins in the same transaction).

- [ ] **Step 1: Schema.** In `0000_talented_medusa.sql`: add `features TEXT NOT NULL DEFAULT '{}'` to `orgs`; add `default_model TEXT` to `users`; add `created_at INTEGER` to `org_members` if absent. Mirror all in `src/schema/index.ts` Drizzle tables. `rm ~/.valet/app.db`.
- [ ] **Step 2: Failing tests** in `services/org.test.ts` (boot in-memory db with migrations the way `credential-store.test.ts` does): isOrgAdmin true for seeded admin, false for a member row you insert; getOrgFeatures default false / true after setOrgFeatures; setOrgMemberRole demote-last-admin returns the exact error string; demote works once a second admin exists; listOrgMembers returns the joined shape.
- [ ] **Step 3: Implement `services/org.ts`.** Plain Drizzle queries; `setOrgMemberRole` wraps count+update in a transaction (`db.transaction` per better-sqlite3 sync driver conventions used elsewhere in the api services).
- [ ] **Step 4: teams.ts swap.** In `canMutateTeam`, replace the `if (user.role === "admin") return true;` shortcut with `if (await isOrgAdmin(db, orgId, user.id)) return true;` (thread `db`/`orgId` — the function already has access; read the file). Update the function's comment. Run the existing teams route tests — they must stay green (local seed makes local-user an org admin; if a test relied on `users.role` alone with no org_members row, fix the TEST's seeding to add the membership row, which reflects the new reality).
- [ ] **Step 5:** `pnpm --filter @valet/api test -- services/org` and `-- teams` green; api `tsc --noEmit`. Commit `feat(api): org features + default_model columns, requireOrgAdmin over org_members.role`.

### Task 2: `/api/me` + `/api/models` (api)

**Files:**
- Create: `packages/api/src/routes/me.ts`, `packages/api/src/routes/me.test.ts`, `packages/api/src/routes/models.ts`, `packages/api/src/routes/models.test.ts`
- Modify: router mounting (find where `credentialsRouter` is mounted and mirror), `packages/api/src/wire/types.ts`

**Interfaces:**
- Consumes: `isOrgAdmin` (Task 1).
- Produces (web Task 6 relies on): wire types `MeResponse {id; email; name: string|null; avatarUrl: string|null; role: "admin"|"member"; orgId; orgRole: "admin"|"member"; defaultModel: string|null}`; `ModelInfo {id: string; name: string; contextWindow: number; reasoning: boolean}`; `GET /api/models → {models: ModelInfo[]}`.

- [ ] **Step 1: Failing route tests** (bootTestApi + fetch, mirroring `routes/credentials.test.ts` style): GET /api/me returns the local user with `orgRole: "admin"` and `defaultModel: null`; PATCH `{name}` updates and round-trips; PATCH `{defaultModel: "claude-haiku-4-5"}` accepts; PATCH `{defaultModel: "not-a-model"}` → 400 mentioning unknown model; PATCH `{defaultModel: null}` clears; PATCH rejects unknown fields (400) and ignores/rejects email (whitelist: name, avatarUrl, defaultModel only); unauth 401. GET /api/models returns a non-empty list containing `claude-haiku-4-5`, each entry matching `ModelInfo`, and requires auth.
- [ ] **Step 2: Implement.** `models.ts`:

```typescript
import { getModels } from "@mariozechner/pi-ai";
// Static registry — no provider API call (spec decision 9).
const models = getModels("anthropic").map((m) => ({
  id: m.id, name: m.name ?? m.id, contextWindow: m.contextWindow, reasoning: m.reasoning === true,
}));
```

(Adapt field names to pi-ai's actual `Model` shape — read `node_modules/@mariozechner/pi-ai/dist/models.d.ts`; narrow, don't cast.) `me.ts`: GET joins `users` + `org_members` for `orgRole`; PATCH validates `defaultModel` against the same `getModels("anthropic")` id set when non-null.
- [ ] **Step 3:** Tests green, mount routers, api suite + tsc. Commit `feat(api): /api/me and /api/models routes`.

### Task 3: `/api/org` + members routes with gate semantics (api)

**Files:**
- Create: `packages/api/src/routes/org.ts`, `packages/api/src/routes/org.test.ts`
- Modify: router mounting, `wire/types.ts`

**Interfaces:**
- Consumes: Task 1 services.
- Produces (web Task 7 relies on): `OrgResponse {id; name; createdAt; features: {organizations: boolean}; callerRole: "admin"|"member"}`; `OrgMembersResponse {members: Array<{userId; email; name; avatarUrl; role; joinedAt}>}`.

- [ ] **Step 1: Failing tests** (use the `x-valet-test-user-id` impersonation harness — see how `teams-routes` tests seed a second `test-member` user — to exercise the member-vs-admin matrix): GET /api/org as member → 200 with `callerRole: "member"` (spec: GET is member-readable); PATCH /api/org as member → 403; PATCH `{features:{organizations:true}}` as admin → 200, GET reflects it; PATCH `{name}` renames; GET /api/org/members with gate OFF → 404 `{error:"organizations not enabled"}`; with gate ON as admin → member rows; as member → 403; PATCH members/:userId flips role; demoting the sole admin → 400 with the exact copy string; unauth 401.
- [ ] **Step 2: Implement `routes/org.ts`.** Router-level: resolve `orgId` from `c.var.user.orgId` (single-org, spec decision 7). `GET /api/org`: org-member gate only. `PATCH /api/org`: `isOrgAdmin` gate; body whitelist `{name?, features?: {organizations?: boolean}}` (merge into existing features JSON, don't clobber unknown keys). Members routes: `isOrgAdmin` AND `getOrgFeatures(...).organizations` else 404.
- [ ] **Step 3:** Green + suite + tsc. Commit `feat(api): org settings routes with feature gate and last-admin guard`.

### Task 4: EngineHost default-model threading (api)

**Files:**
- Modify: `packages/api/src/engine/host.ts` (`resolveModel` ~502-514, `buildSession` ~153, orchestrator path ~273, `buildChildSession` ~559, `buildWorkflowSession` ~644)
- Create: `packages/api/src/engine/host.default-model.test.ts`

**Interfaces:**
- Consumes: `users.default_model` column (Task 1).
- Produces: behavior only — no new exports.

- [ ] **Step 1: Failing tests** (bootTestApi; set `default_model` on local-user via direct db update): (a) a NEW orchestrator session's `session.options.model.id` equals the user default; (b) with no default set it stays `claude-haiku-4-5`; (c) a child session spawned WITHOUT explicit modelId gets the owner's default, WITH explicit modelId keeps it; (d) **restore-no-clobber regression (spec-pinned)**: create orchestrator session → `session.setModel("claude-sonnet-4-5")` → `engineHost.evictAll()` → set the user default to something else → re-acquire via `orchestratorSessionFor` → the session's model is STILL `claude-sonnet-4-5` (read `packages/engine/src/session.ts` restore semantics first; if restore currently applies `options.model` over the persisted model, the fix is host-side: prefer the stored session's persisted model id when building restore options — implement whichever side the engine's contract indicates, WITHOUT changing engine behavior for explicit createSession).
- [ ] **Step 2: Implement.** Add a private `userDefaultModel(userId): Promise<string | undefined>` on EngineHost (single db read, no caching — settings changes must apply on next build). Call sites: `buildSession`/`buildOrchestratorSession` pass it to `resolveModel(...)`; child/workflow builders use `opts.modelId ?? await this.userDefaultModel(ownerActorUserId)`.
- [ ] **Step 3:** Green (all four cases) + full api suite + tsc. Commit `feat(api): per-user default model feeds session builders`.

### Task 5: Settings shell — rail, layout route, gate-aware nav (web, frontend-design)

**Files:**
- Rewrite: `packages/web/src/routes/settings.tsx` (layout: rail + `<Outlet/>`); Create: `routes/settings.index.tsx` (redirect), `components/settings/settings-rail.tsx`, `components/settings/section.tsx`, `components/settings/field-row.tsx`, `src/api/settings.ts`
- Create: `routes/-settings.test.tsx`
- The four You routes + three org routes are created as thin stubs here (each rendering `<Section title>` with placeholder body) so the shell is navigable; Tasks 6–7 fill them.

**Interfaces:**
- Consumes: `GET /api/me`, `GET /api/org` (Tasks 2–3).
- Produces (Tasks 6–7 rely on): `api/settings.ts` exports `qkSettings = { me: () => [...], org: () => [...], orgMembers: () => [...], models: () => [...] }` with `useMe()`, `useOrg()`, `useModels()`, `useOrgMembers()` hooks + mutations `usePatchMe()`, `usePatchOrg()`, `useSetOrgMemberRole()` (follow `src/api/queries.ts` factory idiom exactly). `Section({title, description?, children})` renders a Newsreader heading + hairline-separated stack; `FieldRow({label, hint?, children, error?})` the label/control row.

- [ ] **Step 1: Invoke the frontend-design skill** and read the spec's Visual direction section. The rail: small-caps group labels (`You`, `Organization`), items as quiet links with moss text + `moss-wash` pill when active (TanStack `activeProps`), max-w rail ~200px, content pane `max-w-2xl` column, page title "Settings" in `font-display`.
- [ ] **Step 2: Failing route-adjacent tests**: rail renders 4 You items always; Organization group ABSENT when `useOrg()` says gate off or `callerRole !== "admin"`, present when gate on + admin (mock the query layer the way existing route tests do); `/settings` redirects to `/settings/profile`; org route direct-nav renders the two exact empty-state strings for member / gate-off.
- [ ] **Step 3: Implement.** Gate-aware visibility derives from the `useOrg()` query (no flash: group renders when data arrives). Org route guard is a shared `<OrgRouteGuard>` wrapper in `settings.organization.tsx`'s layout that renders the empty states.
- [ ] **Step 4:** `pnpm --filter @valet/web test -- settings` green, typecheck, visual check in the browser (dev servers). Commit `feat(web): settings shell with rail and gate-aware org group`.

### Task 6: You sections — profile, assistant + model typeahead, appearance, notifications, enable-org card (web, frontend-design)

**Files:**
- Fill: `routes/settings.profile.tsx`, `settings.assistant.tsx`, `settings.appearance.tsx`, `settings.notifications.tsx`
- Create: `components/settings/radio-card.tsx`, `components/settings/model-combobox.tsx`, `components/settings/enable-org-card.tsx`, `components/assistant/identity-fields.tsx` (extracted from `components/assistant/identity-step.tsx` — the dashboard keeps working through the shared extraction)
- Tests: `routes/-settings.sections.test.tsx`

**Interfaces:**
- Consumes: Task 5's `Section`/`FieldRow`/hooks; `PATCH /api/orchestrator/info` (existing); `GET /api/models` + `PATCH /api/me` (Task 2); `MODEL_CATALOG`/`findModel` from `~/lib/models.ts`.
- Produces: `ModelCombobox({value, onSelect, onClear}: {value: string|null; onSelect: (id: string) => void; onClear: () => void})` — Task 7 does not need it, but it must be reusable enough to later replace the chat-header dropdown.

Section content per the spec's controls inventory (normative — every control listed there, nothing more). Key mechanics:
- **Profile**: name + avatar URL inputs, single Save enabled-when-dirty → `usePatchMe`; email read-only `FieldRow` with the spec's hint copy. Avatar preview via existing `Avatar` primitive.
- **Assistant**: `identity-fields.tsx` extraction (name field + personality textarea + save semantics lifted verbatim from `identity-step.tsx`; the dashboard imports the new module — no behavior change there, its tests stay green). Below it the **Default model** `FieldRow`: `ModelCombobox` = text `Input` + filtered popover list (filter on id and label, case-insensitive); curated `MODEL_CATALOG` matches first with their labels/tier badges, then remaining `useModels()` registry entries by raw id; "System default" clear row when a value is set. Selection → `usePatchMe({defaultModel})`; helper text = spec copy verbatim.
- **Appearance**: three `RadioCard`s (title + one-line description, moss ring when selected) over the existing `~/lib/theme.ts` mechanism — lift the logic from the old `settings.tsx` before deleting it.
- **Notifications**: the four Switch rows, logic lifted from old `settings.tsx`, restyled into `Section`/`FieldRow`.
- **Enable-org card**: rendered at the bottom of the PROFILE route (the rail's You group is per-route; the card belongs to one page — profile is the landing page) when `useOrg()` says admin + gate off; the spec's boxed-invitation styling; Enable → `usePatchOrg({features:{organizations:true}})` → invalidate org key → `router.navigate({to: "/settings/organization"})`.

- [ ] Steps: frontend-design skill invoked; failing tests per section (each renders its controls; profile save PATCHes; combobox filters and selects + clears; enable card hidden for gate-on, fires PATCH; notifications toggle mutation fires; theme radio updates `data-theme`) → implement → green → visual browser pass → commit `feat(web): settings You sections with default-model typeahead`.

### Task 7: Organization sections — general, members, teams UI (web, frontend-design)

**Files:**
- Fill: `routes/settings.organization.tsx` (General), `settings.organization.members.tsx`, `settings.organization.teams.tsx`
- Create: `components/settings/members-table.tsx`, `components/settings/teams-panel.tsx`
- Tests: `routes/-settings.organization.test.tsx`

**Interfaces:**
- Consumes: Tasks 3 routes + Task 5 hooks; existing teams API (`GET/POST/DELETE /api/teams`, `POST/PATCH/DELETE /api/teams/:id/members` — read `packages/api/src/routes/teams.ts` for exact shapes; add `useTeams()` hooks to `api/settings.ts` if none exist in `api/queries.ts`).

Per the spec inventory:
- **General**: org name + Save (`usePatchOrg`); id/created read-only rows; "Turn off organization features" quiet button → confirm `Dialog` (copy: nothing is deleted) → PATCH gate false → navigate `/settings/profile`.
- **Members**: `members-table.tsx` — avatar/name/email/role/joined rows from `useOrgMembers()`; role `DropdownMenu` per row → `useSetOrgMemberRole` optimistic with rollback; sole-admin row's control disabled with `Tooltip` ("an organization needs at least one admin"); footer note spec copy.
- **Teams**: list with member counts; inline create (input + Create, 409 duplicate shown under the field); per-team expandable panel (member rows, role toggle, remove, add-member select drawn from `useOrgMembers()` minus current team members); delete team via overflow `DropdownMenu` → confirm dialog.

- [ ] Steps: frontend-design skill; failing tests (members table renders + role change fires PATCH + sole-admin disabled; teams create/delete/add-member fire the right calls; general rename + disable-gate confirm flow) → implement → green → visual pass → commit `feat(web): organization settings — general, members, first teams UI`.

### Task 8: Dogfood + polish (coordinator, not a subagent)

- [ ] `rm ~/.valet/app.db`; restart dev servers; run the spec's manual dogfood list end-to-end: enable gate → rename org → flip a member role (seed a second user via sqlite3 + `VALET_TEST_AUTH_HEADER` or direct db insert) → create team, add member → set default model via typeahead → new chat thread starts on it while an existing thread's explicit override survives → theme + notification toggles → disable gate returns to profile with group hidden.
- [ ] Record results in `.superpowers/sdd/progress.md`; fix-forward anything found (fix subagents per SDD); final whole-branch review per SDD.

## Self-Review

- Spec coverage: shell/routes (T5), You inventory incl. default model + enable card (T6), org inventory incl. teams UI (T7), gate semantics (T3+T5), requireOrgAdmin + teams swap (T1), me/models/org routes (T2–3), default-model threading + restore-no-clobber (T4), provisioning rule (no code — local seed already admin; stated in spec), dogfood (T8). Deferred by spec: invites, member-visible org info, avatar upload, multi-org.
- Type consistency: `qkSettings`/hook names (T5) consumed by T6–7; `MeResponse.defaultModel` (T2) ↔ `usePatchMe` (T6); `isOrgAdmin` (T1) ↔ T3; exact copy strings centralized in Global Constraints.
- No placeholders: section content is bound to the spec's controls inventory rather than restated as code blocks — the spec is committed and named normative in every task; mechanics with non-obvious shape (combobox, guard, optimistic rollback) are specified inline.
