# Personal MCP Connector Credentials

**Status:** Draft
**Date:** 2026-06-09

## Problem

Custom remote MCP connectors are currently organization-scoped. Admins define the connector URL and authentication, and API-key/bearer credentials live on the `custom_mcp_connectors` row as encrypted org-level static auth.

That works for shared service credentials, but it blocks MCP servers whose authentication model is "each user has their own API key" and where OAuth is unavailable. Excalibur is the motivating case: it requires an API key and cannot be configured globally for the organization without sharing one user's credential across everyone.

The current fallback is to ship a dedicated package plugin, as Typefully does. That works for known, high-value services, but it requires code, generated registries, docs, and a deploy for every API-key MCP server.

## Goals

- Let admins define an approved remote MCP connector once, while each user supplies their own API key or bearer token.
- Reuse the existing custom MCP connector runtime path, policy engine, approval flow, audit log, tool cache, and integration list where possible.
- Keep user secrets in the existing `credentials` table with `ownerType = 'user'`.
- Support common API-key placement modes:
  - `Authorization: Bearer <token>`
  - arbitrary configured header, such as `X-API-Key: <token>`
  - arbitrary configured header plus prefix, such as `Authorization: ApiKey <token>`
  - query parameter, such as `?TYPEFULLY_API_KEY=<token>`
- Preserve current org-scoped API-key/bearer connector behavior.
- Keep the initial product admin-controlled. Users should not be able to point Valet at arbitrary MCP URLs in the first phase.

## Non-Goals

- Fully user-created remote MCP connector definitions in the initial phase.
- Local stdio MCP servers.
- MCP prompts or resources. Tools only.
- Private-network MCP targets.
- Migrating built-in MCP package plugins to custom connector rows.
- Sharing user API keys across users, sessions, or org-level connector records.

## Current State

`custom_mcp_connectors` stores connector definition and, for `authType = 'api_key' | 'bearer'`, the encrypted secret:

- `encrypted_api_key`
- `api_key_header_name`
- `api_key_prefix`

`loadCustomMcpConnectorContext()` decrypts that org secret and composes a `staticAuthHeader`. The integration registry then builds an `McpActionSource` with `noAuth: true` and that static auth header. `session-tools.ts` treats custom API-key connectors as not requiring user credentials.

OAuth custom MCP connectors already use user-owned credentials. The user completes the integration OAuth flow; credentials are stored in `credentials(ownerType='user', ownerId=userId, provider=serviceSlug, credentialType='oauth2')`; tool listing and execution resolve those credentials through the normal integration registry path.

The MCP SDK already supports several relevant transport/auth primitives:

- bearer token from `ctx.credentials.access_token`
- query-param token placement through `authQueryParam`
- static headers through `staticAuthHeader`
- validated non-auth static headers through `additionalHeaders`

The missing capability is "this connector's auth definition is org-approved, but the token comes from the current user's credential row."

## Recommended Design

Add a credential scope to custom MCP connectors:

```ts
type CustomMcpCredentialScope = 'org' | 'user';
```

For `authType = 'oauth'`, credential scope is implicitly user-scoped and unchanged.

For `authType = 'api_key' | 'bearer'`:

- `credentialScope = 'org'` keeps today's behavior: the connector row stores an encrypted org API key and runtime resolution builds `staticAuthHeader`.
- `credentialScope = 'user'` means the connector row stores only the non-secret auth template. Each user connects the service by saving an API key in the `credentials` table. Tool listing and execution resolve that user credential and inject it into MCP requests using the connector's auth placement settings.

The first shipped product should expose this as "Authentication owner" in the admin MCP connector form:

- **Organization credential**: one key configured by admin, available to all users.
- **User credential**: admin defines the connector; each user connects their own key.

## Data Model

Add columns to `custom_mcp_connectors`:

```sql
ALTER TABLE custom_mcp_connectors
  ADD COLUMN credential_scope TEXT NOT NULL DEFAULT 'org'
  CHECK(credential_scope IN ('org', 'user'));

ALTER TABLE custom_mcp_connectors
  ADD COLUMN auth_query_param TEXT;
```

`auth_query_param` is optional and only valid for user-scoped API-key auth in the first phase. If set, the user's token is sent in the query string instead of a header. This generalizes Typefully's package-only `TYPEFULLY_API_KEY` behavior without introducing a separate static org query-param auth path.

Existing rows default to `credential_scope = 'org'`, preserving behavior.

For user-scoped API-key/bearer connectors, the connector row must not require or store `encrypted_api_key`. The user's key is stored as:

```ts
storeCredential(env, 'user', userId, serviceSlug, { api_key: token }, {
  credentialType: 'api_key',
});
```

`credentials.provider` remains the internal service slug. Disconnecting the integration revokes the current user's credential and deletes only that user's integration row.

## Internal Service Identity

For the first phase, connector definitions remain org-owned and `serviceSlug` remains globally unique, matching current downstream tables:

- `credentials.provider`
- `integrations.service`
- `mcp_tool_cache.service`
- `disabled_actions.service`
- `action_policies.service`
- `user_action_policy_overrides.service`
- `action_invocations.service`

This avoids schema churn in policy and cache tables.

Fully user-created connector definitions should not reuse a friendly slug across users unless these tables are widened. If that later product is needed, the safest approach is to assign a globally unique internal service slug per personal connector, such as `personal-mcp-<short-id>`, and store the user-facing name separately.

## MCP SDK Changes

`McpActionSource` needs a way to place a user credential according to a connector-owned auth template instead of always sending it as `Authorization: Bearer <token>`.

Add an option:

```ts
interface DynamicAuthTemplate {
  source: 'access_token';
  headerName?: string;
  headerPrefix?: string | null;
  queryParam?: string | null;
}
```

Behavior:

- If `queryParam` is set, append the token to the MCP URL with that query key.
- Else if `headerName` is set, send `headerName: <headerPrefix> <token>` or `headerName: <token>` when the prefix is empty/null.
- Else use the existing `Authorization: Bearer <token>` behavior.
- Continue to reject ambiguous auth sources. A request must not combine a dynamic user token with `staticAuthHeader`.
- Reuse existing header-name and header-value validation.

This keeps Typefully-like query-param auth and Excalibur-like API-key auth in the runtime connector model without adding a package plugin.

## Worker Runtime Changes

`ResolvedCustomMcpConnector` should include:

```ts
credentialScope: 'org' | 'user';
dynamicAuthTemplate?: DynamicAuthTemplate;
```

`loadCustomMcpConnectorContext(env, db, orgId)` can keep its existing signature for org-scoped connector definitions. It should resolve auth like this:

- `authType = 'none'`: no credentials required.
- `authType = 'oauth'`: user credential required, current behavior.
- `authType = 'api_key' | 'bearer'` and `credentialScope = 'org'`: decrypt org secret and build `staticAuthHeader`, current behavior.
- `authType = 'api_key' | 'bearer'` and `credentialScope = 'user'`: do not decrypt `encrypted_api_key`; build `dynamicAuthTemplate`; require user credential at listing/execution time.

`requiresUserCredential(provider)` should return true for custom API-key/bearer connectors with `credentialScope = 'user'`.

`listTools()` should discover user-scoped API-key/bearer connectors from the user's active integration rows, not by auto-injecting them for every user. Tools should be listed only when:

- the connector is active, and
- the user has an active integration row for the connector service slug, and
- the current user has a credential for the connector service slug.

If the user has an active integration row but the credential is missing, return a tool discovery warning and mark the integration as error using the existing warning path.

`executeAction()` should:

- resolve the user's API-key credential through `integrationRegistry.resolveCredentials()`;
- pass the token as `access_token` or a neutral token field accepted by `McpActionSource`;
- let `McpActionSource` apply the connector's dynamic auth template.

## Integration API Changes

`GET /api/integrations/available` should include active user-scoped API-key/bearer custom connectors, not only OAuth custom connectors.

The returned service entry should include:

```ts
{
  service: string;
  displayName: string;
  authType: 'api_key' | 'bearer';
  supportedEntities: [];
  hasActions: true;
  hasTriggers: false;
  isCustomConnector: true;
  credentialScope: 'user';
}
```

`POST /api/integrations` already accepts arbitrary string services and credentials. Extend custom connector validation so a user-scoped API-key/bearer connector can be configured through this endpoint:

- resolve the active custom connector by service slug;
- validate that `credentialScope = 'user'`;
- validate a non-empty token in `credentials.access_token`, `credentials.api_key`, or `credentials.token`;
- optionally test the MCP connection by calling `tools/list` with the submitted credential and dynamic auth template;
- store the credential as `credentialType = 'api_key'`;
- upsert the user integration row as active.

`DELETE /api/integrations/:id` already revokes the user's credential for `integration.service` and deletes the user integration row. That behavior is correct for user-scoped MCP credentials.

## Frontend Changes

Admin MCP connector dialog:

- Add "Authentication owner" when `authType` is API key or bearer.
- For "Organization credential", show today's secret fields.
- For "User credential", hide org secret input and show only the auth template fields:
  - header name
  - prefix
  - optional query parameter
- Make the copy explicit that users will connect their own key from the Integrations page.

Connect Integration dialog:

- Include user-scoped API-key/bearer custom connectors from `/integrations/available`.
- Render them with the existing token setup step.
- Use the connector display name and generic MCP icon unless a later icon field is added.
- Submit through `POST /api/integrations`, not `/auth/me/credentials`, so the integration row and credential stay in sync.

Integration list:

- Show connected user-scoped custom MCP connectors as normal user integrations.
- Use `displayName` from the API response when available.
- Label the credential type as "API key connected" or "Bearer token connected", rather than always "OAuth connected".

## Policy And Tool Catalog

No policy schema change is needed for phase one because connector definitions remain org-owned with globally unique `serviceSlug`.

Org admins can set org policies for a user-scoped connector exactly as they can for org-scoped connectors today. User approval overrides continue to work because they are keyed by user plus service/action.

For fully user-created connector definitions, this assumption changes. Either internal slugs must be globally unique per connector, or the policy/cache tables must gain a connector identity dimension. Do not allow two users to define different tool surfaces behind the same `service` key.

## Security

The phase-one model is intentionally admin-controlled:

- Users cannot introduce arbitrary MCP URLs.
- Outbound URL policy remains centralized on the connector definition.
- Org admins can disable or delete the connector for everyone.
- Org deny policies remain absolute.
- User API keys are encrypted at rest in the existing `credentials` table.
- User API keys are never copied onto the connector row or exposed to other users.

Tool descriptions and schemas still come from the remote MCP server. The existing action policy and approval system remains the mitigation for risky tools. Admins should treat enabling a remote MCP connector as approving that server's tool surface for the organization, even when credentials are personal.

## Options Considered

### 1. Dedicated Package Plugin Per Service

This is the Typefully model. It is low risk for one provider and gives the best product polish, but it requires code and deploys for every MCP server. It does not solve the general Excalibur-class problem.

### 2. Org-Defined Connector, User Credential

This is the recommended phase one. It solves the API-key-per-user problem while preserving admin control over remote URLs and policy.

### 3. Fully User-Created Personal MCP Connectors

This is the broadest product, but it raises service identity, policy, catalog, and outbound governance questions. It should be a later phase after the user-credential model is working.

## Rollout Plan

1. Add schema/types for `credentialScope` and `authQueryParam`.
2. Extend connector creation/update validation for user-scoped API-key/bearer connectors.
3. Add dynamic auth template support to the MCP SDK.
4. Update runtime credential resolution in `session-tools.ts`.
5. Extend integration routes to list and configure user-scoped API-key/bearer connectors.
6. Update admin and user integration UI.
7. Add tests for:
   - org-scoped API-key behavior remains unchanged;
   - user-scoped API-key connector does not expose tools without a user credential;
   - connecting stores a user credential and active integration row;
   - listing and execution send the token using header, prefix, or query-param template;
   - disconnect revokes only the current user's credential;
   - org policy and user overrides still apply.

## Open Questions

- Should admin-created connector slugs remain auto-generated from display name only, or should admins be able to set a stable slug for clearer policy naming?
- Should `tools/list` be required as a live connection test when users save API keys, or should we allow saving credentials when the remote MCP server is temporarily unavailable?
- Should the connect dialog support provider-specific help URLs on custom connectors?
- Do any target MCP servers require static non-auth headers that are user-specific? If yes, the credential shape may need to support more than one user-provided secret.
