# Admin audit log and security alerts

Status: implemented (2026-11-03).

## Why

On 2026-11-02 an attacker became org admin on a fresh instance through a sign-up gap, since closed. The attacker then created about 70 LLM providers that pointed at internal addresses, invited a second account, created image sources, started about 145 bakes, and edited the setup commands of the built-in `default-full` image. Nothing recorded who made these changes, and nothing raised an alert. Detection took about 18 hours.

This design adds two things:

1. A durable record of each admin configuration change: who, what, when, and from where.
2. An alert for each high-risk change, which an operator can route to a pager or a chat channel.

SSRF checks on provider URLs, built-in image immutability, and second-admin approval are separate work.

## Storage

Table `admin_audit_events` (app schema, `packages/api/migrations/pg/0000_app.sql`, Drizzle `adminAuditEvents`, plus a `SCHEMA_REPAIRS` entry for deployed databases):

| Column | Meaning |
|---|---|
| `id` | `aud_<uuid>` |
| `org_id` | The org the change applies to |
| `actor_user_id`, `actor_email` | The signed-in caller. Null for a system change, such as a boot promotion |
| `action` | `<target_type>.<verb>`, such as `llm_provider.create`. Stable: filters and alerts key on it |
| `target_type`, `target_id`, `target_name` | The changed thing |
| `changes` | Redacted field summary, usually `{ field: { from, to } }` |
| `ip`, `user_agent` | From the request. The IP is the socket peer, or the first `x-forwarded-for` hop when `VALET_TRUST_PROXY=1` |
| `created_at` | Epoch milliseconds |

Index `admin_audit_events_org_created` on `(org_id, created_at DESC, id DESC)` serves every read. No read scans without it.

## Write path

`services/admin-audit.ts` owns the table. Each mutation calls `recordAdminAudit` once, after the change succeeds. Routes call it through `routes/_admin-audit.ts`, which fills the actor, org, IP, and user agent from the request. A refused or failed request writes no row.

A write inside a database transaction records after the commit. PGlite serves one connection, so a second write during an open transaction waits on itself.

### Failure policy

The change is already committed when the audit write runs. If the write fails, the request still succeeds. A 500 for a change that took effect invites a retry that applies the change twice. The failure is loud instead:

- An error log line names the action and target and tells the operator to review the change by hand.
- The failure counts in `valet.errors{area="api", reason="admin_audit_write"}`.
- The alert for a high-risk change still fires, because it does not depend on the row.

### Secrets

Callers pass field names and safe values only. An LLM provider key records `key_set` with `keyLast4`, never the key. An invite records its id, role, and email, never the code. A credential records its service, scope, and type, never the secret or the 1Password reference.

`sanitizeChanges` is the backstop on every row:

- It drops any key whose name looks like a secret (`apiKey`, `token`, `password`, and similar).
- It reduces each URL to scheme, host, and path, which removes userinfo and query strings.
- It masks `NAME=value` when the name contains `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, or ends in `_PAT`, and it masks `Bearer`/`Basic` values. Setup commands keep their text, so a reviewer can read what a bake runs.
- It caps strings at 500 characters, arrays at 50 items, and depth at 4.

## What is audited

| Area | Actions |
|---|---|
| Org admins and roles (`routes/org.ts`) | `org_member.grant_admin`, `org_member.revoke_admin`, `org_member.role_change` |
| Boot promotion (`auth/bootstrap-admin.ts`) | `org_member.grant_admin` with a null actor and `via: AUTH_ADMIN_EMAILS` |
| New users (`auth/provisioning.ts`, all sign-in methods) | `user.join` with the role and the invite id |
| Invites (`routes/org-invites.ts`) | `invite.create`, `invite.revoke` |
| Org (`PATCH /api/org`) | `org.update`; SSO team sync and SSO team groups record as `auth_policy.update` |
| Org settings (`routes/org-settings.ts`) | `org_settings.update` |
| LLM providers (`routes/llm-providers.ts`) | `llm_provider.create`, `.update`, `.delete`, `.key_set`, `.key_clear` |
| Image sources (`routes/sources.ts`) | `image_source.create`, `.update`, `.delete`; `bake.start` for a manual bake; `image_source.change_requested`, `.change_rejected`, `.change_withdrawn` for second-admin approval. An approval writes `image_source.create` or `.update` with the approver as actor and `requestedBy` and `approvedBy` in the changes |
| Shared credentials (`routes/credentials.ts`) | `credential.set`, `credential.delete` at org or team scope; `credential_share.create`, `credential_share.revoke` |
| Plugins (`PATCH /api/org/plugins/:name`) | `plugin.entitlement_update` |
| Policies (`routes/policies.ts`, `routes/team-policies.ts`) | `org_policy.create`, `.update`, `.revoke`; `team_policy.create`, `.update`, `.revoke`, `.override_set`, `.grant_revoke` |
| Model policy | `model_policy.approved_models_update`, `model_policy.tiers_update` |

A member's own personal credential is not an admin change and writes no row.

Sign-in methods (`AUTH_METHODS`, OIDC settings) come from the environment at boot. No route changes them at runtime, so there is nothing to audit there. The runtime sign-in policy is SSO team sync, which is audited and alerts.

## Alerts

`recordAdminAudit` raises an alert when the caller marks the change high risk:

| Kind | When |
|---|---|
| `new_admin` | A member becomes admin, an admin invite is created, a boot promotion runs, or a new user joins as admin |
| `new_user` | A new user joins as a member |
| `llm_provider_created` | Any new LLM provider |
| `llm_provider_base_url_changed` | The stored base URL changes |
| `image_source_created` | Any new image source, and a request to create one |
| `image_source_changed` | `externalRef`, `setupCommands`, or `parentId` changes, and a request to change them |
| `builtin_image_changed` | Any change to, or delete of, the `default-full` base |
| `sign_in_policy_changed` | SSO team sync or SSO team groups change |

Each alert emits:

1. A structured warn log line with `event: "security.admin_change"`, the kind, action, target, actor, IP, and `changedFields` (the changed field names only). Values, such as setup commands, stay in the audit row, so no command text or credential leaves the instance in an alert.
2. The counter `valet.security.admin_changes{kind}` (Prometheus: `valet_security_admin_changes_total`).
3. A best-effort `POST` of the same JSON body to `VALET_SECURITY_ALERT_WEBHOOK_URL`, when the operator sets it. The post has a 5-second timeout and does not delay the request. A failure counts in `valet.errors{reason="security_alert_webhook"}`.

Setup commands are stored as their count and a SHA-256 digest, never their text: a command can carry a credential in any option or header, so no mask list covers them all. Admins read the commands on the source itself. Other strings in the row get the masking backstop: secret-named keys, `NAME=value` secrets, URL user info and queries, bearer tokens, credential headers, and options such as `-u user:pass` and `--password value`.

The webhook URL is fixed at deploy time. No admin setting changes it, so an attacker who holds an admin account cannot turn the alert off.

### Why not the event subscription system

Event subscriptions route events from plugin trigger catalogs (GitHub, Slack, Linear) into assistant deliveries and workflows. Internal `valet` events reach only event waiters. Neither path can deliver to a webhook or a chat channel without an agent turn, and an attacker with an admin account can edit subscriptions and workflows. The log line, the counter, and the operator webhook stay outside admin control.

## Read API

`GET /api/org/audit-log` (org admin only, 403 for a member or a team API key):

- Newest first, keyset cursor on `(created_at, id)`. Rows in the same millisecond order by id.
- `limit` defaults to 50 and is capped at 200. A limit below 1 or a malformed cursor returns 400.
- Optional filters: `targetType` (one of the listed target types) and `actorUserId`.
- Response: `{ events: AdminAuditEventWire[], nextCursor: string | null }`.

## UI

Settings, Organization, Security and audit, Audit log (`/settings/organization/audit-log`): when, who, what, and target, newest first, with Load more. A row expands to show the recorded changes, IP, and user agent.

## Limits

- No retention sweep. The table grows by one row per admin change, which is small.
- The operator bake-queue reorder, tag-key edits, team create and delete, and team membership changes are not audited in this change.
- The IP is the socket peer unless `VALET_TRUST_PROXY=1`. Behind a proxy without that setting, it is the proxy address.
