# Artifacts and memory viewer design

Date: 2026-08-22
Status: implemented

## Problem

Valet has no way to hand a document to a human. When the agent writes a
report, a plan, or a summary, the content lives in one of two places:

- a chat message, which is trapped inside the session transcript, or
- a memory file, which only the owner can read through the `/memory` page.

There is no link the agent can return, no page a teammate can open, and no
path to show a document to someone outside the org. The v2 stack has no
sharing infrastructure at all: every content route requires auth, and the
only unauthenticated surface is webhook ingress.

A second, related gap: reading a memory file from inside a chat session is
painful. The `mem_read`/`mem_write` tool renderers clamp rendered markdown
to 40 lines with a "show all" toggle
(`packages/web/src/components/session/tool-renderers/markdown-view.tsx`).
Expanding a long document inline stretches the transcript. Worse, memory
cross-links inside those rendered files are dead: `Markdown` only resolves
relative memory targets when the caller passes `memoryLinks`
(`packages/web/src/components/markdown.tsx:134`), and the tool-renderer
bodies never do. A link like `../people/alice.md` falls through to the
external-link branch and opens a dead tab against the app origin. The
`/memory` page opts in and works; the chat UI does not.

## Decision

Two features, one seam:

1. **Artifacts** — an explicit `mem_share` tool snapshots a memory file
   into a new `artifacts` table and returns a stable URL. The link
   requires a logged-in user in the same org by default. A human can widen
   one artifact to anonymous access, but only when the org has opted in.
2. **Memory viewer** — a large dialog that renders one memory file
   full-page inside the chat session. It opens from memory tool renderers
   and from memory cross-links, and it hosts the human side of sharing
   (the share button and the visibility control).

Sharing is always explicit. Writing a file under any memory path — including
`artifacts/` — never publishes it. The `artifacts/` directory is a
convention for documents meant to be shared, not a publish trigger.

## Visibility model

An artifact has one of two visibility levels:

| Visibility | Who can open the link | How it is set |
|---|---|---|
| `org` (default) | Any logged-in user in the artifact's org | `mem_share` tool, or the share button in the UI |
| `public` | Anyone with the link, no login | A human clicks the toggle in the UI, and only if the org setting allows it |

Rules:

- The `mem_share` tool can only create `org` artifacts. The agent cannot
  create or widen to `public`.
- Widening to `public` is a human action in the web UI. The artifact owner
  or an org admin can widen; the same actors can narrow back to `org`.
- The public toggle is dead unless the org setting
  `allowPublicArtifacts` is on. The setting is opt-in (default off) and
  org-admin gated.
- The setting is live-checked on every read. If an admin turns it off,
  existing `public` artifacts immediately fall back to `org` auth. No
  sweep is needed.

## Snapshot semantics

An artifact is a copy of the memory file's content at share time, not a
live reference. Reasons:

- A live reference gives the public internet a read path into
  `memory_files`, including future edits the owner never meant to publish.
- Memory reads for users union in team scopes
  (`resolveReadableOwners`); a live share route would have to re-implement
  or bypass that logic.

To publish an update, the agent (or the user) runs `mem_share` again on the
same path. Re-share overwrites the stored content and keeps the same token,
so the link stays stable. Revoking and re-sharing mints a new token, so a
leaked link dies with the revoke — and resets visibility to `org`: revoke
ends the audience decision along with the link, so the tool surface can
never be the thing that restores anonymous access.

## Data model

New app table `artifacts` (Drizzle schema in
`packages/api/src/schema/index.ts`, raw SQL in
`packages/api/migrations/pg/0000_app.sql`, edited in place per the pre-1.0
rule):

```ts
export const artifacts = pgTable("artifacts", {
  id: text("id").primaryKey(),                    // nanoid
  // Unguessable capability token, >= 128 bits, base64url. Unique.
  token: text("token").notNull().unique(),
  ownerType: text("owner_type").notNull(),        // user | team | org
  ownerId: text("owner_id").notNull(),
  orgId: text("org_id").notNull(),                // auth boundary for `org` visibility
  actorUserId: text("actor_user_id").notNull(),   // who shared
  sourceSessionId: text("source_session_id"),     // session that ran mem_share, if any
  sourceMemoryPath: text("source_memory_path").notNull(),
  title: text("title").notNull(),                 // from the file's # heading
  content: text("content").notNull(),             // markdown snapshot
  visibility: text("visibility").notNull().default("org"), // org | public
  publicBy: text("public_by"),                    // userId that widened, audit
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  revokedAt: bigint("revoked_at", { mode: "number" }),
});
```

- Unique index on `(owner_type, owner_id, source_memory_path)`. Re-share
  is an upsert on that key.
- Revoke sets `revokedAt`; the row stays for audit. Re-share after revoke
  clears `revokedAt` and replaces `token`.

Org setting: one boolean column on `orgs`, following the
`bareSkillCommands` pattern:

```ts
allowPublicArtifacts: boolean("allow_public_artifacts").notNull().default(false),
```

## Tool surface

One new engine ToolDef next to the `mem_*` tools in
`packages/api/src/orchestrator/memory-tools.ts`, using the same transport
(HTTP to `ctx.config.apiBaseUrl` with `x-valet-internal` +
`x-valet-owner`/`x-valet-actor` headers):

```
mem_share { path, revoke? }
```

- `mem_share { path }` — snapshot the file at `path` into an artifact
  (create or refresh) and return `{ url, visibility, updatedAt }`.
- `mem_share { path, revoke: true }` — revoke the artifact for `path`.
- The tool refuses paths the owner scope cannot read, and refuses
  `team:{id}/...` virtual paths in v1 (share your own copy instead).
- The tool result always states the audience ("anyone in your org who is
  logged in") so the agent relays it accurately.

Agent guidance (rule 7 of `MEMORY_RULES` in
`packages/api/src/orchestrator/persona.ts`, and the "Sharing documents"
section of `packages/plugin-memory/skills/memory/SKILL.md`):

- Put documents meant for humans under `artifacts/` (type `note`).
- Share only when the user asks for a link or clearly wants to hand the
  document to someone. Do not share proactively.
- The flow is: `mem_write artifacts/report.md` → `mem_share
  artifacts/report.md` → give the user the URL.

No approval gate in v1. The tool is explicit, org-scoped, and revocable,
and it cannot reach `public`. If proactive sharing becomes a problem, the
share route can grow a decision gate later.

## API routes

### Read (mounted before auth middleware, like webhook routes)

`GET /api/artifacts/:token`

1. Load by token. Missing or revoked → 404.
2. `public` + org setting on → serve.
3. Otherwise resolve the caller's session itself (better-auth
   `getSession` on the request headers). No session → 401. Session but
   not a member of `artifact.orgId` → 404 (do not confirm existence).
4. Serve `{ title, content, updatedAt, visibility }`.
5. Rate-limit by client IP before the token lookup. The IP comes from
   `x-forwarded-for` only when `VALET_TRUST_PROXY=1` (the helm chart sets
   it — the ingress overwrites the header); otherwise the socket peer
   address, which a client cannot spoof. Responses carry
   `X-Robots-Tag: noindex`.

### Internal (tool transport, `x-valet-internal` dual-auth)

- `POST /api/artifacts/share` `{ path, revoke? }` — backs `mem_share`.
  Reads the memory file through the memory service with the owner scope
  from the headers, then upserts the artifact. Always writes
  `visibility: "org"` on create; refresh does not touch visibility.

### Management (authed, session or API key)

- `GET /api/artifacts` — list the caller's artifacts (org admins also see
  the org's).
- `POST /api/artifacts/share` (authed variant) `{ path }` — human-initiated
  share from the memory viewer.
- `PATCH /api/artifacts/:id` `{ visibility }` — widen or narrow. Widening
  to `public` requires `allowPublicArtifacts` on and the caller to be the
  sharer (`actorUserId`) or an org admin. Widening records `publicBy`.
  Management by other members of a team/org owner scope is not
  implemented; add it when a team asks for it.
- `DELETE /api/artifacts/:id` — revoke.

Org setting surface: add `allowPublicArtifacts` to
`PATCH /api/org/settings` (`packages/api/src/routes/org-settings.ts`) and
its response type, following `bareSkillCommands` exactly.

## Public artifact page

New web route `/a/$token`, added to `PUBLIC_ROUTES` in
`packages/web/src/routes/__root.tsx` (the `/login` shape: no AppShell, no
`WorkspaceScopeProvider`).

- Fetch `GET /api/artifacts/:token`. On 401, redirect to `/login` with a
  return-to param so the org-visibility path works for logged-out
  teammates.
- Render: document title, "Shared from Valet" byline with `updatedAt`,
  body through the existing `Markdown` component
  (`packages/web/src/components/markdown.tsx` — GFM, no raw HTML). No
  memory link handling: memory cross-links inside an artifact render as
  ordinary markdown links whose relative targets lead nowhere useful —
  acceptable, because the reader has no memory access either way.
- Share URLs are built server-side, in trust order: `VALET_PUBLIC_URL`,
  else public https `BETTER_AUTH_URL` (the `channels/host.ts` preference
  order), else `BETTER_AUTH_URL`'s origin verbatim (dev and localdev
  deploys), else the request origin. The `BETTER_AUTH_URL` rung matters:
  `mem_share` tool calls reach the api over its own loopback, so a
  request-origin-only fallback would mint unreachable `127.0.0.1` links.

## Memory viewer dialog

New component `packages/web/src/components/memory/memory-viewer-dialog.tsx`.

- A large Radix dialog built on the existing primitive
  (`packages/web/src/components/primitives/dialog.tsx`) with a wider
  content class (`max-w-5xl w-[92vw] h-[90vh]`). Esc and the corner X
  close it.
- Content reuses the single-file view from the `/memory` page. Extract the
  presentational part of `memory-doc.tsx` into a shared `MemoryDocView`
  that takes `path` + `onNavigate`, used by both the route page and the
  dialog. Data comes from the existing `useMemoryDoc` hook.
- In-dialog navigation: memory cross-links inside the dialog update local
  path state (with a back button) instead of routing. An "Open in Memory"
  action jumps to `/memory/$path` for the full two-pane page.
- Share controls live in the dialog header: a Share button that calls the
  authed share route and shows the link, a visibility control
  ("Org members" / "Anyone with the link"), and Revoke. The public option
  is disabled with a hint ("Ask an org admin to enable public sharing in
  Settings → Organization") when `allowPublicArtifacts` is off.

Entry points in the chat session:

1. An expand icon in the header of the `mem_read`, `mem_write`, and
   `mem_patch` tool renderers opens the dialog at that path. The 40-line
   clamp stays as the inline default.
2. Memory cross-links inside rendered memory files open the dialog. This
   also fixes the dead links (see Problem).

### Memory link resolution in chat

`MarkdownBody`, `MarkdownDiffBody`, and `ClampedMarkdown` gain an optional
`memoryLinks` prop and pass it through to `Markdown`. The `mem_read`,
`mem_write`, and `mem_patch` renderers supply it:

- `fromPath` — the tool call's `path` argument, so relative targets
  resolve against the file's own directory (the existing
  `resolveLinkTarget` logic).
- `onNavigate` — opens the memory viewer dialog at the target path,
  instead of the `/memory` route navigation the memory page uses.

The anchor keeps its real `/memory/...` href (existing `memoryHref`
behavior), so meta/ctrl-click and middle-click still open the full memory
page in a new tab.

Two call sites stay opted out, on purpose:

- Chat prose (assistant/user messages): a relative-looking href in model
  text has no memory file behind it. This is the existing rationale on
  `MemoryLinkHandling` and it still holds.
- The sandbox `edit`/file tools on `*.md` paths: those render workspace
  files from the sandbox, not memory files. Only the `mem_*` renderers
  pass `memoryLinks`.

## Security notes

- The token is the only capability for `public` artifacts: >= 128 bits
  from `crypto.randomBytes`, base64url. No listing route is public, so
  there is no enumeration surface.
- `org` visibility checks membership of `artifact.orgId` on every read.
  Leaving the org drops access immediately.
- Content is a snapshot; a share can never leak later memory edits, other
  files, or team-scope reads.
- The public page renders through the existing `Markdown` component, which
  allows no raw HTML.
- Memory files are text and size-capped by the memory service, so the
  `content` column inherits that bound. Binary artifacts are out of scope
  (no blob store exists in v2).

## Out of scope (v1)

- Binary/image artifacts. Needs a blob store; separate design.
- Link expiry. `revokedAt` covers revocation; an `expiresAt` column can be
  added later without migration pain.
- Sharing chat transcripts or sessions. Different object, different spec.
- Editing inside the memory viewer. The dialog is read-only in v1; edits
  go through the agent or the `/memory` page.
- A dedicated "my shares" settings page. `GET /api/artifacts` makes it
  cheap to add later.

## Implementation notes

- `0000_app.sql` is edited in place (pre-1.0 rule), and local dev needs
  `make dev-clean`. The dev-v2 deploy has already applied `0000`, so
  the new table and the new `orgs` column need the
  startup repair path (the `addColumnsMissingFromAppliedMigrations`
  mechanism, extended to create the `artifacts` table if missing) or the
  rollout sticks on the old image.
- The pre-auth mount for `GET /api/artifacts/:token` goes next to the
  webhook mounts in `packages/api/src/app.ts`, with its own rate limiter.
- Wire types (`ArtifactResponse`, `PatchOrgSettingsRequest`, etc.) go in
  `packages/api/src/wire/types.ts`; web hooks follow the `qkMemory` query
  key factory pattern.

## Resolved questions

1. Team-owned memory files: shareable by any team member (share authorizes
   at READ level through the memory routes' `resolveScope`), since a
   reader can already copy the content anywhere.
2. The artifact page shows the sharer's display name to `org` viewers and
   nothing to anonymous readers.

## Return-to after login

`/login` and `/signup` take a `?next=` parameter: the path to land on
after sign-in. The central 401 redirect sets it from the interrupted
location, and the `/a/$token` error state's login link sets it to the
artifact path — so a logged-out teammate who follows a shared link gets
the document after signing in, not the dashboard. All three sign-in paths
honor it: email/password navigates to it, and the social/SSO buttons put
it in the OAuth `callbackURL`.

`next` is attacker-constructable, so `safeNextPath`
(`packages/web/src/lib/next-path.ts`) validates it at the search boundary:
same-origin relative paths only (one leading `/`; `//host` and `/\host`
are scheme-relative in browsers and rejected), and never the auth pages
themselves. Anything else degrades to `/`.

## Deviations from this spec

- The memory viewer dialog reads the caller's OWN memory scope
  (`useMemoryDoc` with no owner filter). In a team assistant's session,
  expanding a team-scoped file shows the viewer's empty state instead of
  the team file. Threading the session owner into the tool renderers is
  future work; the renderers do not know it today.
