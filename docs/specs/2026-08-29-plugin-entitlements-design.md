# Plugin entitlements — a feature-flag rail for plugins

Status: approved design. First consumer: Valet Security.

## Goal

Gate a plugin two ways, with one reusable mechanism every future plugin can opt into:

1. **Instance (operator) switch** — the deployment turns a plugin on or off for the whole instance through existing config (`plugins.allow`/`plugins.deny` in `valet.yaml`, or `VALET_PLUGINS`). Off here means the plugin is absent from every session and every org, regardless of org settings. This is the true global flag.
2. **Org (admin) scope** — an org admin sets, per plugin, one of three modes: `off` (nobody), `all` (every user in the org), or `teams` (only members of named teams). A team picker chooses the teams for `teams` mode.

Effective access for a user = instance-enabled AND the org mode admits the user.

## Default

When an org has not configured a plugin, the mode is `all`. So an instance-enabled plugin is visible to everyone until an admin narrows it. This preserves the pre-flag behavior (Valet Security was always on).

## Storage

A new `orgs.plugin_entitlements` jsonb column, shape:

```
{ "<pluginName>": { "mode": "off" | "all" | "teams", "teamIds": ["team_…", …] } }
```

Keyed by plugin name. A missing key resolves to `{ mode: "all", teamIds: [] }`. Reuses the `orgs.features` / `orgs.model_preferences` jsonb precedent — no new table. In-place migration: edit `0000_app.sql`, the Drizzle `orgs` schema, and add a `SCHEMA_REPAIRS` `ADD COLUMN IF NOT EXISTS` entry.

## Plugins self-describe (the opt-in)

A plugin declares it is gateable on its `ValetPlugin` manifest:

```
gate: { label: "Valet Security", description: "AI security review of a repository." }
```

The api enumerates the loaded plugin set for manifests that carry `gate` — that list drives the admin UI and validates writes. A new plugin becomes gateable by adding `gate` to its manifest and nothing else. This honors the locked "plugins self-describe" decision.

## Resolution service

`packages/api/src/services/plugin-entitlements.ts`:

- `getPluginEntitlements(db, orgId)` — the raw map.
- `getPluginEntitlement(db, orgId, name)` — one entry, defaulted to `all`.
- `setPluginEntitlement(db, orgId, name, entitlement)` — admin write (merge into the jsonb; validate `mode` and that `teamIds` are real org teams).
- `orgAllowsPluginForUser(db, orgId, userId, name)` — `off`→false, `all`→true, `teams`→user is in a listed team (via `isTeamMember`).

The instance layer is separate: `EngineHost.isPluginLoaded(name)` reports whether the deployment gate kept the plugin. Effective access = `isPluginLoaded(name) && orgAllowsPluginForUser(...)`. Keeping the instance check out of the DB service keeps that service pure and testable.

## Enforcement points

1. **Create route** — `POST /api/sessions` for a plugin-backed session kind (security ⇒ plugin `security`). Refuse with 403 when the plugin is not enabled for the caller. A `KIND_TO_PLUGIN` map generalizes this for future kinds.
2. **Session build** — `EngineHost.sessionExtras` filters any gateable plugin the owner's org disables out of the base plugin set, so a disabled action-plugin's tools never reach a normal session. (For security the create gate is primary; this covers future action-plugins.)
3. **Visibility** — `GET /api/org` carries a `plugins` block: for each gateable plugin, `{ instanceEnabled, enabledForCaller }`. The web nav item and the plugin's hub read `enabledForCaller` and hide when false.

## Admin API

- `GET /api/org/plugins` (any member may read; non-admins get read-only) → `{ plugins: [{ name, label, description, instanceEnabled, entitlement: { mode, teamIds }, enabledForCaller }] }`.
- `PATCH /api/org/plugins/:name` (org admin only, `requireOrgAdmin`) → body `{ mode, teamIds }`. Validates the name is gateable, `mode` is in the enum, and every `teamId` is a team of this org. Returns the updated entry.

## Web UI

- New route `settings.organization.plugins.tsx` under the org settings layout (inherits the admin guard). Add "Plugins" to `ORGANIZATION_ITEMS` in `settings-rail.tsx`.
- Per gateable plugin: an off / all users / specific teams radio (the `role="radiogroup"` card pattern from the security preset picker) and, in `teams` mode, a team multi-select sourced from `useTeams()`.
- A new `Checkbox` primitive backs the multi-select (also a reusable primitive).
- `usePatchOrgPlugins()` mirrors `usePatchOrgSettings()` and invalidates the org query.
- The Security nav item (`top-nav.tsx`) and the `/security` hub (`security.tsx`) read `enabledForCaller` for `security` from `useOrg()` and hide / show a quiet empty state when off.

## Adding a new gateable plugin (the paved road)

1. Add `gate: { label, description }` to the plugin's `ValetPlugin` manifest.
2. If it introduces a session kind, add the kind→plugin mapping in the create route.
3. Gate the plugin's own nav/hub on `enabledForCaller`.

Storage, admin API, admin UI, the instance switch, and the per-team resolution are already generic — no other work.
