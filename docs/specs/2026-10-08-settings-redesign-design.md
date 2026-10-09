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
  switcher, or to Profile when the switcher is on the personal workspace.
- **Organization** keeps every existing route. The rail shows four items, and
  each item's page shows a tab bar over the routes it groups:
  - General: General, Members, Teams
  - Models and usage: Models, Proxy
  - Apps and plugins: Plugins, GitHub, Slack, Linear, 1Password, Library
  - Security and audit: Policies, Sandbox settings, Action log

  A plain member still sees only Teams and 1Password, as two rail items.
- Below `sm`, the rail becomes one menu with the same groups.

### 3. Visual language

Settings matches the thread UI:

- Rail items have an icon. The active item is a soft `bg-ink-wash` pill with
  `text-ink`. Group labels are small sentence-case muted text.
- A `Section` is a heading, an optional description, and its rows in one
  `rounded-2xl bg-ink-wash` group divided by hairlines. `FieldRow` keeps the
  label on the left and the control on the right.
- No boxed cards inside a section.

### 4. One place per thing

- Connected accounts keeps identity linking (Slack, Telegram), GitHub, and the
  personal 1Password token. Its second credential list is removed. Integrations
  owns service connections, and Connected accounts links to it.
- The unconfigured-channel copy names Settings → Organization, where the bot
  token lives.

### 5. Integrations

Integrations becomes a list, like Claude's Connectors page:

- Two groups: **Connected** and **Available**. Each row shows the icon, name,
  a one-line status, and its primary action on the right.
- Connected holds a plugin with a service that the caller connected or the
  organization provides. Available holds a plugin the caller can still
  connect. A third group, **Built in**, holds a plugin that needs no
  account, so built-in tools do not crowd the Connected group.
- A saved credential that no listed service covers, for example one left by
  a removed plugin, gets a row with Revoke under **Other saved credentials**.
  The removed Connected accounts list was the only Revoke control for such a
  credential, so Integrations keeps one.
- A row is a link to `?service=<plugin>`, which opens the plugin's details
  (owner, reach, account, pairing, repair notes, controls, and tools) in a
  modal panel. The panel is a URL, so a link can open it. Closing it replaces
  the history entry and keeps `?q=`, so Back does not reopen it. An unknown
  `?service=` opens nothing.
- A team or organization-provided connection shows its scope on the row.
- The team view uses the same row and group components.

### 6. Skills

Skills uses the same list language. Each row shows the name, a one-line
description, the scope, and the kind (skill or prompt), and the whole row
opens the skill. The filters, search, the Catalog and Sources tabs, and New
skill stay.

## Testing

- The rail tests assert the four groups, the team list, the admin and member
  Organization items, and that the rail does not change with the switcher.
- Route tests cover the redirects (`/settings/appearance`, `/settings/threads`,
  `/settings/proxy`, `/settings/team`) and that a team page pins its team scope.
- Integrations and Skills tests assert the row structure and the
  Connected and Available split.
- `make e2e` passes before a deploy.
