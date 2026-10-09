# Settings, Integrations, and Skills Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Settings list every scope explicitly (Account, Personal workspace, each team, Organization) in the thread UI's visual language, and turn Integrations and Skills into grouped lists.

**Architecture:** Settings stops reading the workspace switcher. Team settings move to `/settings/teams/$teamId/*` and personal workspace pages pin personal scope. Both use `PinnedWorkspaceScope`, so the existing sections keep reading `useWorkspaceScope()` unchanged. Organization routes stay and are grouped into four rail items with a tab bar. Integrations and Skills reuse one list-group look.

**Tech Stack:** React 19, TanStack Router (file routes, generated `routeTree.gen.ts`), TanStack Query, Tailwind tokens, Radix, lucide-react icons, Vitest + Testing Library (jsdom).

Spec: `docs/specs/2026-10-08-settings-redesign-design.md`.

## Global Constraints

- Tailwind tokens only (`ink`, `muted`, `line`, `paper`, `moss`, `*-wash`); never slash-opacity on tokens; pair colours with `dark:` variants where a raw colour is used (`docs/guides/styling.md`).
- Reuse primitives (`pageClass`, `TabBar`, `FilterChips`, `Badge`, `Button`, `LoadingRow`/`ErrorRow`/`EmptyRow`); delete code the change replaces.
- UI copy: ASD-STE100, sentence case, "workspace" only for the switcher scope.
- Route tests live in `src/routes/-*.test.tsx`; never hand-edit `routeTree.gen.ts` (the Vite build regenerates it).
- Web typecheck runs through `pnpm --filter @valet/web build` (root `pnpm typecheck` skips web).
- Commits: conventional subjects at most 72 characters, `Changelog:` trailer on feat/fix, no AI trailers.
- `make e2e` passes before deploy.

---

### Task 1: `PinnedWorkspaceScope`

**Files:**
- Modify: `packages/web/src/lib/workspace-scope.tsx`
- Test: `packages/web/src/lib/workspace-scope.test.tsx` (create if absent)

**Interfaces:**
- Produces: `export function PinnedWorkspaceScope({ teamId, children }: { teamId: string | undefined; children: ReactNode }): JSX.Element` — provides a scope whose `key` is `teamId ?? PERSONAL` and `teamId` is `teamId`; `available` and `setKey` come from the outer scope (switching still changes the global switcher).

- [ ] **Step 1: Failing test**

```tsx
it("pins a team scope inside Settings without changing the outer scope", () => {
  function Probe() { const s = useWorkspaceScope(); return <span>{s.key}:{s.teamId ?? "none"}</span>; }
  render(<><PinnedWorkspaceScope teamId="team-1"><Probe /></PinnedWorkspaceScope><Probe /></>);
  expect(screen.getByText("team-1:team-1")).toBeTruthy();
  expect(screen.getByText("user:none")).toBeTruthy();
});
```

- [ ] **Step 2:** Run `pnpm --filter @valet/web test workspace-scope` → FAIL (not exported).
- [ ] **Step 3: Implement**

```tsx
export function PinnedWorkspaceScope({ teamId, children }: { teamId: string | undefined; children: ReactNode }) {
  const outer = useWorkspaceScope();
  const value = useMemo<WorkspaceScope>(
    () => ({ key: teamId ?? PERSONAL, teamId, available: outer.available, setKey: outer.setKey }),
    [teamId, outer.available, outer.setKey],
  );
  return <WorkspaceScopeContext.Provider value={value}>{children}</WorkspaceScopeContext.Provider>;
}
```

- [ ] **Step 4:** Test passes. **Step 5:** Commit `feat(web): pin a workspace scope for settings pages`.

### Task 2: Settings visual primitives

**Files:**
- Modify: `packages/web/src/components/settings/section.tsx`, `field-row.tsx`, `routes/settings.tsx`

**Interfaces:**
- Produces: `Section` keeps `{ title, description, children }`; its rows render in `rounded-2xl bg-ink-wash px-4 divide-y divide-line`. `FieldRow` keeps its props; `py-3.5`. New export `SettingsPageHeader({ title, description, actions })` is not needed — sections carry their own titles.

- [ ] **Step 1:** Change `Section` heading to `text-lg font-medium text-ink`, description `text-sm text-muted`, and wrap children: `<div className="divide-y divide-line rounded-2xl bg-ink-wash px-4">{children}</div>`.
- [ ] **Step 2:** `FieldRow`: `py-3.5`, label `text-sm text-ink`, hint `text-xs text-muted`.
- [ ] **Step 3:** `settings.tsx`: page title `text-2xl font-medium`, rail column `sm:w-56`, content `max-w-3xl`; render `<Outlet />` without the switcher key (Settings no longer follows the switcher); drop the personal-scope redirect (Task 4 moves it).
- [ ] **Step 4:** `pnpm --filter @valet/web test settings` and fix snapshot-free assertions that depended on classes (none expected). **Step 5:** Commit `feat(web): give settings sections the thread UI's grouped rows`.

### Task 3: Settings rail

**Files:**
- Modify: `packages/web/src/components/settings/settings-rail.tsx`
- Test: `packages/web/src/components/settings/settings-rail.test.tsx`, `packages/web/src/routes/-settings.test.tsx`

**Interfaces:**
- Consumes: `useOrg()`, `useTeams()` (`~/api/settings`), `eligibleTeams(teams, organizationsEnabled)`.
- Produces: `RAIL_GROUPS` built per render: `{ label, items: { to, label, icon, match?: (pathname) => boolean }[] }`. Exports `ORG_TEAMS_PATH`, `ORG_ONEPASSWORD_PATH` (unchanged), and `ORG_SECTIONS` (used by Task 5):

```ts
export const ORG_SECTIONS = [
  { label: "General", icon: Building2, routes: [
    { to: "/settings/organization", label: "General" },
    { to: "/settings/organization/members", label: "Members" },
    { to: ORG_TEAMS_PATH, label: "Teams" } ] },
  { label: "Models and usage", icon: Cpu, routes: [
    { to: "/settings/organization/models", label: "Models" },
    { to: "/settings/organization/proxy", label: "Proxy" } ] },
  { label: "Apps and plugins", icon: Blocks, routes: [
    { to: "/settings/organization/plugins", label: "Plugins" },
    { to: "/settings/organization/github", label: "GitHub" },
    { to: "/settings/organization/slack", label: "Slack" },
    { to: "/settings/organization/linear", label: "Linear" },
    { to: ORG_ONEPASSWORD_PATH, label: "1Password" },
    { to: "/settings/organization/library", label: "Library" } ] },
  { label: "Security and audit", icon: ShieldCheck, routes: [
    { to: "/settings/organization/policies", label: "Policies" },
    { to: "/settings/organization/sandbox-images", label: "Sandbox settings" },
    { to: "/settings/organization/action-log", label: "Action log" } ] },
] as const;
```

Groups:
- Account: Profile (`/settings/profile`, User), Preferences (`/settings/preferences`, SlidersHorizontal), Notifications (Bell), Connected accounts (Link2).
- Personal workspace: API keys and proxy (`/settings/api-keys`, KeyRound), Agent access (`/settings/agent-access`, Bot), Policies (`/settings/policies`, Shield); plus Models (`/settings/models`, Cpu) only when the org gate is off.
- Your teams: one item per eligible team, `to: /settings/teams/${team.id}`, icon Users, `match: p => p.startsWith(to)`.
- Organization (gate on): admin → one item per `ORG_SECTIONS` entry, `to` = first route, `match` = any route in the section (Teams subpaths by prefix); member → Teams and 1Password.

- [ ] **Step 1: Failing tests** (replace the old switcher-driven assertions):

```tsx
it("lists every scope regardless of the workspace switcher", async () => {
  mockOrg({ organizations: true, callerRole: "admin" });
  mockTeams([{ id: "t1", name: "team-tvc", callerRole: "member" }]);
  renderRail("/settings/profile");
  expect(groupLabels()).toEqual(["Account", "Personal workspace", "Your teams", "Organization"]);
  expect(screen.getByRole("link", { name: "team-tvc" }).getAttribute("href")).toBe("/settings/teams/t1");
  expect(screen.getByRole("link", { name: "Security and audit" })).toBeTruthy();
});
it("marks an organization section active on any of its routes", () => {
  renderRail("/settings/organization/linear");
  expect(screen.getByRole("link", { name: "Apps and plugins" }).getAttribute("aria-current")).toBe("page");
});
it("shows a member only Teams and 1Password under Organization", () => { /* member mock */ });
```

(Reuse the existing test file's `useOrg`/`useTeams` mocks and router harness.)
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement the groups above. Item styling: `flex items-center gap-2.5 rounded-lg px-2.5 py-1.5`, icon `h-4 w-4`, active `bg-ink-wash text-ink`, idle `text-muted hover:bg-ink-wash hover:text-ink`; group label `px-2.5 text-xs text-muted` (sentence case). Mobile dropdown keeps the same groups. Delete `TEAM_ITEMS`, `isTeamSettingsPath`, `TEAM_SETTINGS_PATH`.
- [ ] **Step 4:** Tests pass. **Step 5:** Commit `feat(web): list every settings scope in the rail`.

### Task 4: Routes for Preferences, personal workspace, and teams

**Files:**
- Create: `routes/settings.preferences.tsx`, `routes/settings.teams.$teamId.tsx` (layout with tabs), `routes/settings.teams.$teamId.index.tsx`, `routes/settings.teams.$teamId.access.tsx`, `routes/settings.teams.$teamId.policies.tsx`
- Modify: `routes/settings.appearance.tsx`, `settings.threads.tsx`, `settings.proxy.tsx`, `settings.api-keys.tsx`, `settings.policies.tsx`, `settings.team.tsx`
- Test: `routes/-settings.team.test.tsx` (rewrite), `routes/-settings.sections.test.tsx`

**Interfaces:**
- Consumes: `PinnedWorkspaceScope`; existing `AppearancePage`, `ThreadDefaultsPage`, `ApiKeysPage`, `SettingsProxyPage`, `PoliciesPage`, `TeamsPanel`.
- Produces routes: `/settings/preferences`, `/settings/teams/$teamId`, `/settings/teams/$teamId/access`, `/settings/teams/$teamId/policies`.

- [ ] **Step 1: Failing tests:** `/settings/appearance` and `/settings/threads` redirect to `/settings/preferences`; `/settings/proxy` redirects to `/settings/api-keys`; `/settings/api-keys` renders the personal API keys and personal proxy even when the switcher holds a team; `/settings/team` redirects to `/settings/teams/<switcher team>` or `/settings/profile`; `/settings/teams/t1/access` renders the team API keys section.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.**
  - `settings.preferences.tsx`: `<div className="space-y-10"><AppearancePage /><ThreadDefaultsPage /></div>`.
  - `settings.appearance.tsx` / `settings.threads.tsx`: keep the exported page components; the route component becomes `<Navigate to="/settings/preferences" replace />`.
  - `settings.proxy.tsx`: route component → `<Navigate to="/settings/api-keys" replace />`; keep `SettingsProxyPage` exported.
  - `settings.api-keys.tsx`: `<PinnedWorkspaceScope teamId={undefined}><div className="space-y-10"><ApiKeysPage /><SettingsProxyPage /></div></PinnedWorkspaceScope>`.
  - `settings.policies.tsx` and `settings.agent-access.tsx`: wrap in `<PinnedWorkspaceScope teamId={undefined}>`.
  - `settings.teams.$teamId.tsx`: resolve the team from `useTeams()`; unknown or not eligible → `ErrorRow` "You are not a member of this team." ; else header (team name, "Open threads" link to `/chat?workspace=teamId`), `TabBar` (General → `/settings/teams/$teamId`, API keys and proxy → `.../access`, Policies → `.../policies`), and `<PinnedWorkspaceScope teamId={teamId}><Outlet key={teamId} /></PinnedWorkspaceScope>`.
  - `.index.tsx`: the `SelectedTeamSettings` body from `settings.team.tsx` (directory loading → `TeamsPanel`).
  - `.access.tsx`: `<div className="space-y-10"><ApiKeysPage /><SettingsProxyPage /></div>`; `.policies.tsx`: `<PoliciesPage />`.
  - `settings.team.tsx`: `useWorkspaceScope().teamId` → `<Navigate to="/settings/teams/$teamId" params={{ teamId }} replace />`, else `/settings/profile`.
- [ ] **Step 4:** `pnpm --filter @valet/web build` (regenerates the route tree, typechecks) and the route tests pass. **Step 5:** Commit `feat(web): give each team its own settings pages`.

### Task 5: Organization section tabs

**Files:**
- Modify: `routes/settings.organization.tsx`
- Test: `routes/-settings.organization.test.tsx`

**Interfaces:**
- Consumes: `ORG_SECTIONS` from Task 3.

- [ ] **Step 1: Failing test:** on `/settings/organization/linear` as admin, a tab bar shows Plugins, GitHub, Slack, Linear, 1Password, Library with Linear selected; a member on Teams sees no tab bar.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** In the org layout (after the guard admits the route), find the section whose routes contain the pathname (Teams subpaths by prefix). If admin and the section has more than one route, render `TabBar` with `Link` tabs above `<Outlet />`.
- [ ] **Step 4:** Pass. **Step 5:** Commit `feat(web): group organization settings into four sections`.

### Task 6: Connected accounts: one place per thing

**Files:**
- Modify: `routes/settings.connected-accounts.tsx`
- Test: `routes/-settings.connected-accounts.test.tsx`

- [ ] **Step 1:** Remove `CredentialsListSection` ("Other credentials") and its revoke dialog; add a closing row: "Connect services for your assistant on the Integrations page." with a link to `/integrations`. Fix the unconfigured copy to "An admin can connect it in Settings → Organization."
- [ ] **Step 2:** Update the tests that asserted the removed list (delete them) and add one for the Integrations link.
- [ ] **Step 3:** Commit `fix(web): keep service connections on Integrations only`.

### Task 7: Integrations list

**Files:**
- Modify: `components/integrations/integration-card.tsx`, `integration-row.tsx`, `routes/integrations.tsx`, `components/integrations/team-integrations.tsx`, `team-connection-setup.tsx`
- Create: `components/primitives/list-group.tsx` (export from `primitives/index.ts`)
- Test: `routes/-integrations.test.tsx`, `routes/-integrations-workspace.test.tsx`

**Interfaces:**
- Produces: `ListGroup({ title, description, children })` — heading plus `divide-y divide-line rounded-2xl bg-ink-wash` container; `ListGroupRow` className constant `listRowClass = "px-4 py-3.5"`.
- `isConnectedService(plugin): boolean` — true when any service is connected or org-provided and ready.

- [ ] **Step 1: Failing tests:** the page renders a "Connected" group holding connected services and an "Available" group holding the rest; each service is a row (`role="listitem"`), not a card.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** `IntegrationCard` becomes `<li className="flex flex-col gap-2 px-4 py-3.5">`; `CardHeading` keeps icon, name, state, one-line description (`line-clamp-1`); `CardFooter` moves controls to the heading row's right (`flex items-start justify-between gap-4`) and drops the mono meta (reach goes into the description line). The page renders two `ListGroup`s (`<ul>` lists) instead of the two-column grid. The team view uses `ListGroup` for team connections and the "Connect a service" list.
- [ ] **Step 4:** Pass. **Step 5:** Commit `feat(web): show integrations as grouped lists`.

### Task 8: Skills list

**Files:**
- Modify: `components/skills/skill-card.tsx`, `skill-grid.tsx`, `routes/skills.index.tsx`
- Test: `routes/-skills.index.test.tsx`

- [ ] **Step 1: Failing test:** skills render as rows in one list group; each row shows the name, description, scope badge, and kind, and links to the skill.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** `SkillCard` → `<li>` with a stretched link, `flex items-start gap-3 px-4 py-3.5 hover:bg-ink-wash-strong`; `SkillGrid` renders `<ul className="divide-y divide-line rounded-2xl bg-ink-wash">`. `RepoSourcesPanel` box → `ListGroup`.
- [ ] **Step 4:** Pass. **Step 5:** Commit `feat(web): show skills as a grouped list`.

### Task 9: Specs, validation, deploy

- [ ] Mark superseded sections in `2026-07-14-split-settings-design.md` and `2026-08-17-team-workspace-ui-design.md` with a pointer to the new spec.
- [ ] `pnpm --filter @valet/web test`, `pnpm --filter @valet/web build`, `make e2e` (full output to a log).
- [ ] Browser check on the local stack: rail groups, a team page, an org section, Integrations, Skills; light and dark; narrow width.
- [ ] Deploy to XORS: branch from the deployed sha, cherry-pick the commits, drop the Agent access rail item if XORS lacks `/settings/agent-access`, validate, `valet-deploy.build-on-server`, verify `/opt/valet/DEPLOYED` and health.
