# Team 1Password vaults

**Date:** 2026-09-04 (revised 2026-09-10)
**Status:** Implemented
**Ticket:** TKAI-361

## Purpose

A team admin connects a service account scoped to the team's vaults. Valet discovers credentials by name without per-reference settings.

This design supersedes the reference grant list. Stored credential `op://` references remain supported; they select a secret, not an access preference.

## Ownership and scope

The existing encrypted credential store holds one `onepassword` row per owner. A team token uses owner `{ type: "team", id: teamId }`, type `service_account`, and `apiKey`. No schema change is required.

`OnePasswordScope` supports `org`, `personal`, and `team`. Team reads carry the trusted team ID through the host, action invoker, readiness predicate, and sandbox broker. The broker derives that ID from its persisted session and checks the team against the sandbox principal's organization. Request bodies cannot select a team principal.

Personal sessions consult org and personal tokens only. Org and unknown owners consult org only. Legacy sessions acting as a member remain org-only unless their reader carries a trusted team principal. Team sessions never borrow the frozen actor's personal token.

## Selection

- Automatic team lookup and broker discovery try the team scope first.
- Only an absent team token permits automatic fallback to org. A legacy grant-only row counts as absent.
- A configured team token is authoritative. A miss, empty search, inaccessible reference, or SDK failure does not trigger org substitution.
- Explicit stored references retain their `tokenScope`. An org reference still resolves through the org token, even when a team token is connected.
- Broker `scope` selects one allowed scope. Explicit `org` remains available to team sessions; `team` remains unavailable to personal sessions.
- Stored team-scope references require team ownership. Token delegation remains prohibited.
- Plain org credential fallback still requires the existing org-provided policy. Adding a team token does not expand that policy.

A service-name lookup with multiple matching items returns an actionable ambiguity error before reading a value. `find` returns separate candidates. Duplicate vault or item titles use stable IDs so the selected reference identifies one item. The command wrapper refuses multiple candidates and preserves the scope on a unique match.

## Token management

Team admins and org admins can PUT or DELETE `/api/credentials/onepassword` with team scope. PUT requires `service_account` and `apiKey`, without caller-supplied metadata or other secret fields.

Writes take `lockTeamForOwnership`, the same transaction lock used by `deleteTeam`. They then lock the tenant-scoped team and the authorizing org/team membership rows with `FOR SHARE`. Role updates and membership deletion cannot interleave with an authorized write. The lock order matches team OAuth credential writes. Token replacement and disconnect serialize even when no credential row exists.

`GET /api/onepassword/team-status?teamId=…` returns only `tokenConnected`, based on encrypted-column presence. It does not decrypt a token or contact 1Password. Team members and org admins can read status. A connected status means a token is stored, not that the provider has accepted it.

The existing vault probe accepts team scope for team administrators. Its result contains vault identifiers and titles, never secret values. The team settings surface provides connect, replace, and disconnect controls; no reference editor exists.

## Retired reference preferences

The reference Grant/Remove UI, query hooks, client methods, wire types, routes, parser, and runtime gates are removed. The former `/api/teams/:id/onepassword-refs` routes return 404. There is no compatibility facade.

Existing `metadata.refs` is ignored. Deployment does not scan, migrate, or delete credential rows. An explicit token replacement removes the obsolete key while retaining other metadata. Ignoring an old grant never deletes a token. Explicit disconnect removes the selected team's token row.

Vault access is controlled by the service account's permissions and Valet's owner/membership authorization. Every token-accessible reference can resolve without a Valet grant.

## SDK and caches

The API continues to use one SDK adapter. Client construction is memoized per token; failed construction is evicted. Resolve, lookup, and inventory keys include org, scope, owner ID, and token digest. Token reads precede cache access, so rotation and deletion take effect immediately. Team inventory and item failures propagate instead of becoming partial search results.

SDK failure logs contain fixed operation labels. Neither raw upstream error messages, token values, nor secret references are logged by this adapter.

## Limits

Team vault isolation requires the org service account not to have access to those same vaults. Connecting a team token cannot revoke permissions already held by the org token.

The sandbox broker delivers secret values to commands. An arbitrary command can print or transmit an injected value. This feature does not guarantee plaintext non-disclosure from team members who can execute such commands. Strict non-disclosure requires a separate execution boundary.

## Validation

Focused tests use synthetic credentials, fake SDK clients, and ephemeral databases only:

- `services/team-onepassword.test.ts`: owner routing, rotation, deletion, explicit org references, authoritative team misses/errors, personal isolation, ambiguity, and duplicate-title find/resolve round trips.
- `routes/team-onepassword-token.test.ts`: permission matrix, status, atomic replacement, revoked authority, team deletion, retired endpoints, and legacy metadata preservation.
- `routes/sandbox-secrets.test.ts`: trusted team identity, no-grant discovery/resolution, inaccessible reference refusal, empty results, explicit scope, and no broader fallback.
- `services/credential-resolution.test.ts`, `plugins/action-invoker.test.ts`, and `workflows/team-service-readiness.test.ts`: consistent runtime/readiness behavior and ignored legacy preferences.
- `engine/secrets-cli-script.test.ts`: unique selection, ambiguous selection refusal, and scope retention.
- Team connection and settings UI tests: loading/error states, role controls, cleared drafts, disconnect confirmation, and absence of reference preferences.
