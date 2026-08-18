# Assistant editor and per-assistant behavior

Status: designed, not yet implemented. Builds on
`2026-08-13-assistants-design.md`, which deferred skill restriction and tool
assignment. This pass delivers both, plus per-assistant personality and the
editor page. Per-assistant documents stay deferred.

## Why

Requests will be routed to specific assistants (event subscriptions, channel
bindings, workflow nodes). A routed request is only useful when the target
assistant behaves differently from its siblings. Today every assistant an
owner holds is identical: same personality file, every skill, every
integration. The only editable field is `name`, and team assistants have no
edit surface beyond the rail's rename dialog.

This pass makes an assistant's behavior configurable per row: personality,
which skills it gets, which integrations (and which of their actions) it
gets. A dedicated editor page exposes it.

Out of scope, each for its own later pass:

- Inter-assistant messaging inside a team. Runtime plumbing with its own
  failure modes (loops, permissions); the editor does not depend on it.
- Per-assistant documents and memory. Memory, journal and skills storage stay
  per-principal, shared by every assistant the principal owns.
- Org-owned assistants. Still unreachable, unchanged.

## Data model

Two nullable columns on `assistants`. Null means today's behavior, so
existing rows need no backfill.

```
assistants
  ...existing columns...
  personality  text               -- null: fall back to the owner's
                                  --   assistant/personality.md memory file
  behavior     text               -- JSON AssistantBehavior; null: everything
```

```ts
interface AssistantBehavior {
  skills?:
    | { mode: "all" }
    | { mode: "allowlist"; names: string[] };
  integrations?:
    | { mode: "all" }
    | { mode: "allowlist"; entries: IntegrationEntry[] };
}

interface IntegrationEntry {
  service: string;              // plugin service key, e.g. "github"
  excludeActions?: string[];    // fully-qualified ids, e.g. "github.create_issue"
}
```

Skills are keyed by name because name is already the merge key: stored
skills shadow plugin skills by name (`mergedSkillSources`). Action excludes
use the same fully-qualified ids the action-policy tables store, so one id
scheme covers policies and excludes.

Granularity is integration-level with per-integration action excludes.
Whole-integration attachment matches how users think about capability
("this assistant gets GitHub and Linear"); the exclude list handles the
sharp-edged action without forcing per-action curation of the whole catalog.

Pre-1.0 rules apply: edit `0000_app.sql` and the Drizzle schema in place,
then `rm -rf ~/.valet/pg`. No backfill.

### Why columns, not memory files or a side table

Config as per-assistant memory files would keep personality agent-editable,
but config-as-memory is stringly typed, wake-time enforcement would parse it
defensively, and admin-gating team memory writes is new auth machinery. A
separate `assistant_configs` table is 1:1 with `assistants`; a join with no
benefit at this stage.

## Persona resolution

`resolvePersonaPrefix` gains one preference step: use `assistants.personality`
when set; when null, read the owner's `assistant/personality.md` exactly as
today. The cap (`PERSONALITY_INJECT_CAP`) and the "no name, no prefix" rule
are unchanged.

The personal-default identity flow (`PATCH /api/orchestrator/info`,
`/settings/assistant`, the dashboard identity fields) keeps writing the
memory file. The file stays the fallback, so that flow keeps working
untouched. The editor writes the row column. When both exist, the row wins;
the editor shows the row value.

## API

No new routes and no new auth code. Both mutating routes already gate on
`canAdministerAssistantOwner` (team admin for a team's assistant, yourself
for your own).

- `PATCH /api/assistants/:id` accepts `personality?: string | null` and
  `behavior?: AssistantBehavior | null`. Null clears a field back to the
  fall-through (memory file / everything). Validation rejects malformed
  modes and entries with corrective messages ("skills.mode must be 'all' or
  'allowlist'.").
- `POST /api/assistants` accepts the same optional fields, so
  create-with-config is one call.
- `AssistantSummary` gains `personality` and `behavior`. The editor loads
  from the list query the client already holds; no per-assistant GET is
  added. Personality is capped text and behavior is a small object, so the
  summary stays small.
- A PATCH that changes `personality` or `behavior` calls
  `engineHost.evictCache(row.sessionId)`: cache-only eviction, the same seam
  the identity PATCH uses (`routes/orchestrator.ts`). An in-flight turn
  finishes on the old config; the next wake rebuilds with the new one.
  `destroy()` is not used because it would kill a running turn.

The editor needs no new catalog endpoints. `GET /api/plugins` already
returns each integration with its fully-qualified action list, and
`GET /api/skills` lists the skills an owner can reach.

## Host enforcement

One funnel: `buildAssistantSession` (`packages/api/src/engine/host.ts`),
which already loads the assistant row.

- **Integrations.** `sessionExtras` gains an optional behavior filter that
  only this builder passes. Allowlist mode keeps a plugin's actions only
  when its service is listed, then drops excluded action ids inside kept
  services. The filter touches actions only. Plugin-provided skills are
  governed by the skills config, never by the integrations config.
- **Skills.** The merged skill sources (plugin + stored) are filtered by the
  name allowlist, in both the build-time seed and the `skillsProvider`
  re-read. The provider closure captures the build-time behavior. That is
  safe because every behavior PATCH evicts the cache, so a stale closure
  never outlives its config.
- **Never gated:** memory tools, pinned actions, and the child-session tools.
  These are the assistant's substrate, not integrations.
- **Dangling entries** (a renamed skill, a removed plugin) are skipped at
  wake. The assistant simply does not get that entry.
- **Failure posture:** `behavior` JSON that does not parse (only possible
  through a bug, since PATCH validates) is logged and treated as
  "everything". Attachment is capability shaping, not a security boundary.
  Action policies and approval gates stay the enforcement layer, so failing
  open here cannot bypass security.

## Editor page

Route: `/assistants/$assistantId`
(`packages/web/src/routes/assistants.$assistantId.tsx`), reached from a new
"Edit assistant" item in the rail's per-assistant dropdown. The rail's "+"
keeps its fast path (create, then open the chat). No index page; the rail is
the list.

Settings-page layout with per-section saves:

1. **Identity.** Name input and personality textarea.
2. **Skills.** Radio: "All skills" / "Only these", then a checkbox list from
   `GET /api/skills` for the assistant's owner. A dangling allowlisted name
   renders as a "not found" chip the editor can remove.
3. **Integrations.** Radio: "All integrations" / "Only these", then a
   checkbox per service from `GET /api/plugins`. A checked service expands
   to an optional action-exclude picker.
4. **Manage.** Make default and archive, the same mutations the rail menus
   use.

An ownership clause at the top states whose assistant this is, following the
workspace-clause convention (`2026-08-17-team-workspace-ui-design.md`): the
editor states ownership, it does not ask for it.

Team members who are not admins get the page read-only with a note: "Only
team admins can edit this assistant." The admin check reuses the role data
the teams queries already expose. The API stays authoritative: a non-admin
PATCH still 404s.

Mutation errors render inline under their section and the page stays open,
matching the dialog convention. Every error message names the corrective
action.

## Testing

- API integration tests (`assistants.test.ts`): personality/behavior PATCH
  round-trip, create-with-config, validation rejections, evict-on-patch,
  non-admin 404, archived-assistant 409.
- Host tests: persona preference order (row over file over none);
  integration allowlist and action excludes reach the built session's tool
  list; the skills allowlist filters both the seed and the provider re-read;
  dangling entries are skipped.
- Web route tests for the editor page, following the existing
  `-settings.*.test.tsx` pattern: render, read-only for non-admin, section
  save wiring.
- Validation is a clean `make e2e` scorecard.
