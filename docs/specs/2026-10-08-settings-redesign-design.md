# Settings, Integrations, and Skills redesign

**Status:** Approved 2026-10-08. Supersedes the navigation and visual sections of
`2026-07-14-split-settings-design.md` and the Settings part of
`2026-08-17-team-workspace-ui-design.md`.

## Problem

The Settings rail changed with the workspace switcher. With the personal
workspace selected, API keys, Proxy, and Policies sat under **You**. With a team
selected, the same three pages moved into a **Team** group, and their content
changed to the team's. To reach another team's settings, a person had to leave
Settings and change the switcher first. The Organization group listed 14 pages
in one flat column.

The same thing was also configured in more than one place. Examples: two GitHub
connect flows, two credential lists with different verbs, team connections on
two pages, and copy that sent people to the wrong page for the Slack bot token.
The thread UI was redesigned on 2026-10-06 with flat rows, soft washes, and
large radii. Settings, Integrations, and Skills still used hairline stacks and
boxed card grids.

## Decisions

### 1. Settings names every scope; work pages follow the switcher

Settings no longer reads the workspace switcher. The rail lists every scope the
person can manage at once, which is the model Linear uses (Account, then each of
your teams, then admin-only administration). Pages that hold work (Threads,
Integrations, Skills, Workflows) still follow the switcher, which is the model
ChatGPT uses for workspaces. A page therefore always shows which scope it acts
on: Settings by its rail group, a work page by the switcher.

A settings page that acts on a workspace pins the scope from its route with
`PinnedWorkspaceScope` (`lib/workspace-scope.tsx`). The existing sections read
`useWorkspaceScope()` as before and do not change. The global switcher is not
changed by visiting Settings. The browser tab title names the pinned workspace
on these pages, not the switcher's.

### 2. Rail groups

| Group | Items | Scope |
|---|---|---|
| Account | Profile, Preferences, Notifications, Connected accounts | you |
| Personal workspace | API keys and proxy, Agent access, Policies | your personal workspace |
| Your teams | one item per team you belong to | that team |
| Organization | General, Models and usage, Apps and plugins, Security and audit | the organization (admins) |

- **Preferences** joins Appearance and Thread defaults on one page.
  `/settings/appearance` and `/settings/threads` redirect to it.
- **API keys and proxy** joins the two pages for the personal workspace.
  `/settings/proxy` redirects to it.
- **A team** opens `/settings/teams/$teamId`, a page with tabs: General (the
  team panel: members, defaults, Slack home channel, connections), API keys and
  proxy, and Policies. `/settings/team` redirects to the team selected in the
  switcher, or to Profile when the switcher is on the personal workspace or
  holds a team the caller is no longer on. It waits for the teams and org
  queries before it decides, because the switcher keeps a stored team while
  they load. A draft on one team's tab does not carry to another team's page.
  Deleting the team, or removing yourself from it, on this page opens Profile.
- **Organization** keeps every existing route. The rail shows four items, and
  each item's page shows a tab bar over the routes it groups:
  - General: General, Members, Teams
  - Models and usage: Models, Proxy
  - Apps and plugins: Plugins, GitHub, Slack, Linear, 1Password, Library
  - Security and audit: Policies, Sandbox settings, Action log

  A plain member still sees only Teams and 1Password, as two rail items, and
  no tab bar.
- While organizations are off, Personal workspace also lists Models.
- Below `sm`, the rail becomes one menu with the same groups.

### 3. Visual language

Settings matches the thread UI:

- Rail items have an icon. The active item is a soft `bg-ink-wash` pill with
  `text-ink`. Group labels are small sentence-case muted text.
- A `Section` is a heading, an optional description, and its rows in one
  `rounded-2xl bg-ink-wash` group divided by hairlines. `FieldRow` keeps the
  label on the left and the control on the right.
- No boxed cards inside a section. A group with no rows is hidden.

### 4. One place per thing

- Connected accounts keeps identity linking (Slack, Telegram), GitHub, and the
  personal 1Password token. Its second credential list is removed. Integrations
  owns service connections, and Connected accounts links to it with
  `?workspace=user`, so the link opens your personal Integrations whatever the
  switcher holds. On Integrations the switcher navigates with the workspace it
  chose, so the parameter cannot hold the page on Personal.
- The unconfigured-channel copy names Settings → Organization, where the bot
  token lives.

### 5. Integrations

Integrations becomes a list, like Claude's Connectors page. It follows the
switcher.

- Three groups. **Connected** holds a plugin with a service that the caller
  connected or the organization provides. **Available** holds a plugin the
  caller can still connect. **Built in** holds a plugin that needs no
  account, so built-in tools do not crowd the Connected group.
- A row is one line: the mark, the name, and the description (hidden below
  `sm`). On the right it shows a badge only when the connection needs
  attention (Expired, Refresh failed, Sign-in only, or Not configured for a
  leftover credential on an unconfigured service). An unconnected row shows
  what it offers instead: Connect, Set up (an org admin can configure it), or
  Organization (the organization provides it). A healthy connection shows no
  badge. The name truncates before the badge does.
- A row is a link to `?service=<plugin>`, which opens the plugin's details
  in a modal panel: who owns the connection (Your account, or Managed by your
  organization), its reach, the account, pairing, repair notes, the controls,
  and the tools. A link can open the panel. Closing a panel that a row click
  opened goes back to the list entry, so open and close cycles add no history.
  Closing a panel that a link opened replaces its entry. Either way the list
  keeps `?q=`, and Back does not reopen the panel. An unknown `?service=`
  opens nothing. Disconnect on a credential that stores a 1Password reference
  says that the 1Password item is not deleted.
- A saved credential that no listed service covers, for example one left by
  a removed plugin, gets a row with Revoke under **Other saved credentials**.
  The removed Connected accounts list was the only Revoke control for such a
  credential, so Integrations keeps one.
- The team view lists the team's connections under Connected and the
  services the team can still connect under Available, with the team's
  1Password row in the group that matches its state. It uses the same parts
  (`Section`, `IntegrationList`, `CardHeading`), but its rows carry their
  controls in line and open no panel, and it ignores `?service=`. On a phone,
  a team row states why its control is disabled on a line under the row.

### 6. Skills

Skills uses the same list language. Each row shows the mark, the name, the
scope badge (a team row names its team), a Repo badge for a repository skill,
a prompt badge for a stored prompt, the description (hidden below `sm`), and
the id an agent passes (hidden below `md`). The whole row opens the skill.
The filters, search, the Catalog and Sources tabs, and New skill stay.

## Testing

- `settings-rail.test.tsx`: the four groups, teams by name through the typed
  team route, the admin and member Organization items, Models while
  organizations are off, the phone menu, and a rail that does not change with
  the switcher.
- `-settings.routes.test.tsx` (real router, real layout and scope provider):
  the redirects from `/settings/appearance`, `/settings/threads`, and
  `/settings/proxy`; Preferences with both parts; personal Policies pinned while
  the switcher holds a team; a team's API keys and proxy and Policies tabs;
  and the Organization tabs for an admin but not a member.
- `-settings.team.test.tsx`: the team page pins its team, marks its tab,
  refuses a team the caller is not on, and drops a draft when another of the
  caller's teams opens; `/settings/team` redirects; the personal API keys and
  proxy page pins personal scope.
- `workspace-scope-pinned.test.tsx`: a pinned scope and the tab title.
- `-integrations.test.tsx` and `-integrations.router.test.tsx`: the three
  groups, the row states and offers, the panel as a URL (Back, `?q=`, an
  unknown service), `?workspace=user`, and Other saved credentials.
  `-integrations-workspace.test.tsx` covers the team view.
- `-skills.index.test.tsx` and `-skills.stored.test.tsx`: one list and the
  scope badges.
- `make e2e` passes before a deploy.
