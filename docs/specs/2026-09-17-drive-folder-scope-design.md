# Drive folder scope

Status: implemented (2026-09-17), revised after review (2026-09-21)

A person connects Google Workspace and the assistant can reach every file
the OAuth grant covers, which is their whole Drive. There was no way to
narrow it. This adds a folder scope: a list of folders the assistant may
use, enforced on every Drive, Docs and Sheets action.

## What existed before

Two things looked like folder scoping and were not.

`folderId` is an optional parameter on several Drive actions. The model
chooses whether to pass it, so it filters a search; it does not bound what
the assistant can reach.

`labels-guard.ts` is a complete access guard keyed on Drive labels, and it
has been inert in v2 since the plugin conversion: `resolveGuardV2()` returns
null because `PluginActionContext` carries no `guardConfig`. Only the legacy
worker ever populated one. The folder scope does not revive that path. It
reads the person's own credential instead, which needs no new host plumbing.

A third thing was broken outright. `drive.search_files` sent
`'<id>' in ancestors` for its `folderId` parameter. `ancestors` is a Drive
v2 query term; v3 removed it and answers 400, so a folder-scoped search
failed. See "Search" below.

## Where the scope lives

`credentials.metadata.settings.driveFolderScope` on the `google_workspace`
row, as `{ folderIds: string[] }`. The grant it narrows belongs to the row's
owner, a person or a team, so the scope sits beside it rather than in org
settings.

`settings` is the one part of credential metadata that survives a token
write. Three writers save the whole row with a fresh `metadata` object: the
OAuth callback on a reconnect, the first Google sign-in that seeds the row,
and the refresh store after a token refresh. Left alone, any of them would
drop the scope and silently widen the grant, and the refresh store's
read-modify-write could revert a scope saved while a refresh was in flight.
So `CredentialStore.save()` never writes `settings`: on insert it drops the
key from what it was given, and on conflict it keeps the stored value. Only
the scope routes write it, with a targeted jsonb update. `PUT
/api/credentials/:service` refuses a body that carries `metadata.settings`,
naming the route that owns it, rather than accepting it and changing
nothing.

Three states, and two of them look alike:

| Stored | Meaning |
| --- | --- |
| absent | No scope. Access is as wide as the OAuth grant. |
| `{ folderIds: ["a"] }` | Folder `a` and everything under it. |
| `{ folderIds: [] }` | Nothing is readable. |

An empty list denies. Someone who sets a scope and then empties it has not
asked for unrestricted access, and reading `[]` as "everything" would invert
the setting. Removing the restriction is `DELETE`, which deletes the key.

## Enforcement rests on one check

Drive v3 cannot express a subtree in a query. It has `in parents`, which
matches direct children, and nothing recursive. Expanding a scope into every
descendant folder id would mean an unbounded walk whose OR clause outgrows
the `q` parameter.

So there is one primitive, `FolderContainment.isInside`
(`packages/plugin-google-workspace/src/actions/folder-scope.ts`), which
walks a file's parents upward until it reaches an allowed folder or runs out
of tree. A Drive file can have several parents, so the walk is over a DAG,
not a chain; visited ids are tracked, so a cycle terminates. Depth is capped
at 32. Every parent lookup is cached for the life of one action call, so a
page of siblings pays for their shared ancestors once.

Every category uses that one check, through `withFolderScope` in
`actions/actions.ts`:

- **list and search** — the result is filtered. Each of `files`,
  `documents`, `folders` and `spreadsheets` is filtered and a `total`
  beside it is recomputed. `nextPageToken` is left alone, because it is
  Drive's own paging: a page can come back shorter than requested, or empty
  with a token still set.
- **read and write** — the target file id has to be inside the scope. The
  check runs before the action, so a refused call never reaches Drive. A
  copy or a move names a second folder, the one the file ends up in, and
  that destination is checked too: otherwise scoped content could be copied
  or moved out of the scope.
- **create** — the destination folder has to be inside the scope. With no
  destination named and exactly one allowed folder, the scope's folder is
  filled in, because the alternative is creating in the Drive root where the
  scope cannot contain it. With several allowed folders there is no default,
  so the action asks for one. `sheets.create_spreadsheet` names no folder at
  all and is refused with the two actions that can place a file.
  `drive.create_from_template` also checks the template, which it reads.
- **unclassified** — refused. A new action is unreachable under a scope
  until it is classified, which fails toward the scope holder rather than
  exempting itself. A test asserts no action is currently unclassified.

One primitive is the point. Two mechanisms could disagree, and a
disagreement inside an access control reads as a bypass.

## Failure direction

A scope that is set and cannot be evaluated denies. A Drive outage while
walking parents, a tree past the depth cap, an action with no file id: each
denies. Failing open here would hand over the whole Drive whenever Google
has a bad minute.

A 401 is the exception: it is returned as-is so the session's token refresh
can run and retry. Everything else answers with one message, worded the way
Drive words a missing file, so a scoped-out file is not distinguishable from
one that does not exist.

Stored folder ids are treated as hostile on the way in and on the way out.
The api rejects anything outside `[A-Za-z0-9_-]+` on write, and
`resolveFolderScope` drops such an id on read, so an id that reaches a Drive
query cannot close a quote.

Drive accepts `root` as a file id but reports the canonical id, never the
alias, in a file's parents. The api refuses `root` in a scope, since a
scope holding it is not a restriction and the unrestricted state is no
scope at all. `FolderContainment` resolves the alias once, through
`files.get('root')`, so a search naming `root` as its folder still works.

## Search

`drive.search_files` keeps its documented meaning — a folder and everything
under it — and gets there through the same containment check rather than the
query term Drive removed. Its description now warns that a folder-scoped
page can be shorter than `maxResults`, so the agent keeps following
`nextPageToken` instead of concluding there is nothing left.

## API

All four routes act on the caller's own credential by default, or on a
team's with `?scope=team&teamId=`. A read admits any member and an org
admin; a write and the picker need a team admin, the same gates the team
credential routes use. An org holds no Drive credential a session would
read, so `scope=org` is refused.

A team row that a member shared (`metadata.delegatedFrom`) carries no scope
of its own. The read follows the reference to the member's row and answers
with their scope plus `delegatedFrom`, so the team page can show whose it
is. A write on such a row is refused: the folders are set on the member's
own connection.

- `GET /api/credentials/google_workspace/folder-scope` → `{ folderIds }`,
  `null` when unset.
- `PUT` with `{ folderIds }` → stores it. At most 50 folders; duplicates
  collapse; a malformed id is a 400 naming where to find a real one.
- `DELETE` → removes the restriction, answering `{ folderIds: null }`.
- `GET /api/credentials/google_workspace/drive-folders?parentId=` → one
  level of the folder tree for the picker. Folders only: a scope names
  folders, and offering files would imply they can be picked.

The scope is written with a targeted update to the `metadata` column. A
read-modify-save through `CredentialStore.save` would round-trip the
encrypted secret columns for a change that touches none of them.

Every message names its corrective action inside the `error` string. The
web client renders `error` verbatim and ignores a separate `corrective`
field, so a fix that lives only in `corrective` never reaches the reader.

## UI

`components/integrations/drive-folder-scope.tsx` adds a "Folders" control to
the Google Workspace tile, beside "Share with a team". Drive is the only
credential whose reach a person can narrow after connecting, so the control
sits on the tile rather than in a per-integration settings screen that does
not exist yet. Right after a Google Workspace connect, the page opens the
control once, so the choice is offered while the grant is fresh in mind.

The team page renders the same component on the team's Google Workspace
row. A team admin gets the picker on the team's own connection. A shared
connection shows one line instead ("Limited to 2 folders by <member>", or
"All of <member>'s Drive"), because the scope is the member's. A plain
member sees the line without a control.

The popover states the current reach ("All of your Drive", "2 folders", or
"No folders — nothing is readable"), browses the folder tree with a
breadcrumb, and keeps selections made in other folders while browsing.
"Allow all of Drive" clears the scope; it does not save an empty list.
"Save" is refused on an empty selection, so the two states one click apart
cannot be reached by accident.

## Testing without a Google account

The plugin and the api read `GOOGLE_DRIVE_API_URL` and use it as the Drive
base URL, the way `GITHUB_API_URL` stands in for GitHub.
`packages/api/scripts/drive-fixture.ts` serves a small in-memory Drive tree
on that URL: `files.get` with the `root` alias, `files.list` with the query
terms the plugin builds, create, copy, rename, move, delete and export. With
both processes pointed at it and any token stored on the credential, the
picker, the scope and every drive.* action can be clicked through, and the
fixture's log shows which calls the scope let reach Drive and which it
refused before asking. Docs and Sheets are not served: neither is part of
the scope.

## Not covered

- Shared drives beyond what containment reaches. A file in a shared drive
  resolves parents the same way, so a shared-drive folder can be scoped, but
  nothing special-cases `driveId`.
- A folder picked and later deleted or moved out from under the scope. The
  containment check answers against Drive's current tree, so access follows
  the move. Nothing prunes a stale id from the stored list.
- The inert labels guard. It stays unreachable in v2; this change neither
  revives nor removes it.
