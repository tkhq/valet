# Security plugin route adoption implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Move the Security HTTP routes that the generic plugin route mount can serve into the Security plugin. Keep every existing URL, status code, and response body. Record why each remaining route stays in the API.

**Architecture:** The plugin declares its routes, parses requests, and shapes responses. The API authorizes the caller for the session in the path, then binds a narrow Security capability to that one request. The capability reads and writes the existing relational tables through the existing services.

**Tech Stack:** TypeScript, Hono, Drizzle, Vitest, portable Request and Response types.

**Spec:** ../specs/2026-10-07-plugin-http-interfaces-design.md

## Global constraints

- No Hono, database, or API package imports in plugin code.
- No schema changes, data rewrites, or ticket updates. TKAI-378 owns the Security storage decision.
- Keep each legacy `/api/sessions/...` URL as a host-owned compatibility alias of the canonical plugin route.
- Bind a capability only after the host confirms identity, organization membership, and session access.
- Capability methods take no user, organization, or session ID. The host binds all three.
- Do not widen the generic route mount. A route that admits a team API key or the internal token today stays in the API.

## Caller classes

The Security router admits three caller classes. The generic mount admits only the first.

| Class | Credential | Principal | Generic mount |
| --- | --- | --- | --- |
| Acting user | Session cookie, personal API key, `valet login` token, local stub | `user` | Admitted after the organization membership check |
| Team key | Team API key | `team`; `user` is the minting administrator | Refused |
| Internal tool | `x-valet-internal` plus `x-valet-session-id` | None | Refused; the mount strips both headers |

The router uses five authorization ladders:

- **View read:** a valid internal token passes without an acting-session check. Otherwise the principal needs `canViewSession`. A refusal answers 404 `session not found`.
- **Tool:** an internal caller must send `x-valet-session-id` (401 without it). A mutation requires the acting session to be `:id`. A read also admits a child session that a cell of this engagement claims. Other internal callers get 403. A principal needs `canViewSession` for reads and `canAdministerSession` for mutations; a refusal answers 404.
- **Persona:** internal callers only; others get 404. The acting session must hold a running cell claim (403 without one). `:id` must be the acting session or the engagement's runner session (403 otherwise).
- **Human:** the internal token gets 403 with the human-action message. A principal needs `canViewSession` (404 otherwise). Administration routes also need `canAdministerSession` and answer a corrective 403.
- **Preview:** any request with a user. The internal token gets 401 `authentication required`.

No route has a body limit today. Hono buffers the full body before `c.req.json()`.

## Route inventory

All legacy paths are under `/api/sessions`. "View", "Tool", "Persona", and "Human" name the ladders above.

| # | Method and legacy path | Ladder and ownership | Input | Main responses | Decision |
| --- | --- | --- | --- | --- | --- |
| 1 | GET `/:id/security` | View | none | 200 engagement, cells, cost, plan, diff, report, needs, resume state; 404 session or engagement | Stays: internal, team key |
| 2 | GET `/:id/security/findings` | View | query severity, status, limit, cellId, path, cursor | 200 page with links, handoffs, comments; 400 filter or cursor; 404 | Stays: internal, team key |
| 3 | GET `/:id/security/coverage` | View | none | 200 ledger and rollup; 404 | Stays: internal, team key |
| 4 | POST `/security/preview` | Preview; GitHub token from the caller's organization | JSON repo, preset, paths, ref, includeReport | 200 config and plan; 400 shape; 401 | Stays: team key |
| 5 | GET `/:id/security/status` | Tool read | none | 200 resume state with child status; 404 | Stays: internal, team key |
| 6 | GET `/:id/security/start-preview` | Tool read; GitHub token from the session organization | none | 200 repo, SHA, cells; 409 repo or ref; 404 | Stays: internal, team key |
| 7 | GET `/:id/security/files` | Tool read; persona claim fallback | query path, revision | 200 file; 400; 404 | Stays: internal, team key |
| 8 | GET `/:id/security/files/list` | Tool read; persona claim fallback | query prefix | 200 listing; 404 | Stays: internal, team key |
| 9 | POST `/:id/security/plan` | Tool mutate | JSON plan | 200 plan; 400; 409 | Stays: internal, team key |
| 10 | POST `/:id/security/plan/cells` | Tool mutate | JSON cells | 200 plan; 400; 409 | Stays: internal, team key |
| 11 | POST `/:id/security/config` | Tool mutate | JSON focus, invariants, categories | 200 engagement; 400; 409 | Stays: internal, team key |
| 12 | POST `/:id/security/start` | Tool mutate | JSON resolvedSha | 200 cells; 400; 409 | Stays: internal, team key |
| 13 | POST `/:id/security/dispatch` | Tool mutate; spawns a child session | JSON cellId, mode, threadId | 200 child; 400; 409; 429 child limit | Stays: internal, team key |
| 14 | POST `/:id/security/cells/:cellId/complete` | Tool mutate | none | 200 cell; 404 cell; 409 | Stays: internal, team key |
| 15 | POST `/:id/security/cells/:cellId/fail` | Tool mutate | JSON reason | 200 cell; 400; 409 | Stays: internal, team key |
| 16 | POST `/:id/security/close` | Tool mutate; routes an attention notice | none | 200 manifest; 409 | Stays: internal, team key |
| 17 | POST `/:id/security/handoff` | Tool mutate; spawns a fix session | JSON findingId, task, threadId | 200 child; 400; 404; 409; 429 | Stays: internal, team key |
| 18 | POST `/:id/security/files` | Persona | JSON path, content | 200 revision; 400; 409 | Stays: internal only |
| 19 | POST `/:id/security/findings` | Persona | JSON severity, title, body, file, line | 200 finding; 400; 409 | Stays: internal only |
| 20 | POST `/:id/security/findings/:findingId/review` | Persona; review cells only | JSON status, reason | 200 finding; 400; 409 | Stays: internal only |
| 21 | POST `/:id/security/coverage` | Persona | JSON area, status, tool, reason | 200 row; 400; 409 | Stays: internal only |
| 22 | POST `/:id/security/report` | Persona; report cells only | JSON markdown, json | 200 report; 400; 409 | Stays: internal only |
| 23 | POST `/:id/security/needs` | Persona | JSON kind, description | 200 need; 400; 409 | Stays: internal only |
| 24 | GET `/:id/security/report` | View | none | 200 report or null; 404 | Stays: internal, team key |
| 25 | GET `/:id/security/report/export` | Human view; audit row | query format | 200 attachment; 400; 404 | Stays: team key |
| 26 | GET `/:id/security/needs` | View | none | 200 needs; 404 | Stays: internal, team key |
| 27 | POST `/:id/security/findings/:findingId/status` | Human administer | JSON status, reason | 200 finding; 400; 403; 404; 409 | Stays: team key |
| 28 | POST `/:id/security/findings/:findingId/comments` | Human view | JSON body | 200 comment; 400; 404 | Stays: team key |
| 29 | POST `/:id/security/needs/resolve` | Human administer | JSON answers | 200 needs; 400; 403; 404; 409 | Stays: team key |
| 30 | POST `/:id/security/cancel` | Human administer; destroys children, routes an attention notice | none | 200 engagement; 403; 409 | Stays: team key |
| 31 | POST `/:id/security/resume` | Human administer | JSON cellIds, reason | 200 outcome; 400; 403; 409 | Stays: team key |
| 32 | GET `/:id/security/export` | Human view; audit row | query format, severity, status, cellId | 200 attachment; 400; 404 | Stays: team key |
| 33 | POST `/:id/security/findings/:findingId/issues` | Team key refused first, then Human view; provider call with the caller's credentials | JSON provider, repo, teamId | 200 link; 400; 403; 404; 502 | **Moves** |
| 34 | POST `/:id/security/issues/digest` | Team key refused first, then Human view; provider call with the caller's credentials | JSON provider, findingIds, repo, teamId | 200 URL; 400; 403; 404; 502 | **Moves** |

"Internal" means the sandbox tools call the route with the internal token. "Team key" means a team API key reaches the route today; `team-api-keys.access.test.ts` covers row 1. Both classes need an authorization category that the generic mount does not have. Adding one would widen the mount's authority, so these routes stay in `packages/api/src/routes/security.ts`.

## Moved routes

| Route ID | Canonical path | Legacy alias | Body limit |
| --- | --- | --- | --- |
| `finding-issue` | POST `/api/plugins/security/http/sessions/:id/findings/:findingId/issues` | POST `/api/sessions/:id/security/findings/:findingId/issues` | 16 KiB |
| `issue-digest` | POST `/api/plugins/security/http/sessions/:id/issues/digest` | POST `/api/sessions/:id/security/issues/digest` | 256 KiB |

The digest limit holds several thousand finding IDs. Request handling runs in this order:

1. The auth middleware, the team-key scope check, and the agent-authority check run unchanged.
2. A team API key gets 403 with the existing team-key filing message.
3. The internal token gets 403 with the existing human-action message.
4. Other callers without an acting user get the generic 401.
5. A caller without organization membership gets 403.
6. A body above the route limit gets 413 `payload too large`.
7. The host binder loads the session. A missing session, or a caller without `canViewSession`, gets 404 `session not found`.
8. The binder loads the engagement and binds the capability to the request object.
9. The plugin answers 404 with the existing message when the session has no engagement.
10. The plugin validates the body, files through the capability, and shapes the response.

Steps 2 and 3 are host-owned compatibility refusals. They only refuse requests, so they do not widen the mount.

## Capability

```ts
interface SecurityIssuesCapability {
  /** Null when the bound session has no security engagement. */
  readonly engagement: SecurityEngagementIssues | null;
}

interface SecurityEngagementIssues {
  fileFindingIssue(input: { findingId: string; provider: SecurityIssueProvider; repo?: string; teamId?: string }): Promise<SecurityFindingIssueResult>;
  fileDigestIssue(input: { findingIds: string[]; provider: SecurityIssueProvider; repo?: string; teamId?: string }): Promise<SecurityDigestIssueResult>;
}
```

The host adapter keeps the finding lookup scoped to the bound engagement, the `(finding, provider)` idempotency index, the action invoker with the caller's credentials, and the error classification. Results are discriminated outcomes: filed, unknown finding, foreign findings, refused (400), and provider failure (502).

The capability is a `PluginHttpCapability` key that the plugin owns. The host binds a value to the request object that the mount created. Plugin code cannot bind identity to a request that the host did not authorize.

## Behavior differences

These differences come from the generic mount. They apply only to the two moved routes.

- A user without organization membership gets 403. Before, a former member could still file issues from a session they own.
- A body above the limit gets 413. Before, the route buffered any size.
- When the Security plugin is not loaded, both URLs answer 404. The other 32 routes stay mounted, as before.
- The canonical URL refuses team API keys with the general team-key scope message.

## Review focus

- A team API key, the internal token, and a non-viewer must not reach the capability.
- A finding ID from another engagement must not be filed.
- A request body cannot choose the user, organization, session, or engagement.
- Oversized and malformed bodies must not call a provider or write a link.
- Legacy URLs must keep status codes, bodies, and content types.

## Task 1: Pin parity on the legacy mount

Files: create `packages/api/src/integration/security-issue-routes.test.ts`.

- [x] Assert exact status and body for an unknown session, a foreign viewer, a session without an engagement, a malformed body, each invalid field, a foreign finding, foreign digest IDs, an empty digest, a missing integration, the internal token, and an idempotent repeat.
- [x] Run the suite against the legacy router before any route moves.

## Task 2: Add the binding seam

Files: update `packages/engine/src/plugin-http.ts`, `packages/api/src/plugins/http-routes.ts`; create `packages/api/src/plugins/http-capabilities.ts`.

- [ ] Add `PluginHttpCapability<T>`, a typed key that binds a value to one request object.
- [ ] Let the host compatibility map give authenticated routes a legacy alias. Require the alias to repeat the route's parameter names.
- [ ] Add host-owned team-key and internal-token refusal messages to the compatibility map.
- [ ] Run a host binder after authentication, membership, administration, and body checks. A binder response stops the request before the plugin runs.
- [ ] Test that refused callers never reach the binder or the handler.

## Task 3: Move issue filing into the plugin

Files: create `packages/plugin-security/src/http.ts` and `packages/api/src/plugins/http-security.ts`; update `packages/plugin-security/src/plugin.ts`, `packages/api/src/routes/security.ts`, and the HTTP design spec.

- [ ] Declare `finding-issue` and `issue-digest` with `user` authentication and the limits above.
- [ ] Move body parsing, validation messages, outcome-to-status mapping, and response shaping into the plugin.
- [ ] Implement the host binder and adapter over the existing tables and issue service.
- [ ] Delete both handlers from the API router.
- [ ] Run the parity suite against both URLs, plus the membership, body limit, and cross-user cases.
- [ ] Run the Security, team-key, plugin mount, and loader suites, typecheck, and `make e2e`.

## Remaining Security adoption

The other 32 routes need one of these decisions before they can move:

- An authorization category for internal tool callers that binds the acting session, its claimed cells, and the runner relation. The category must not admit other credentials.
- A decision on team API keys for Security human routes. Rows 25 and 27 to 32 stamp the minting administrator as the actor. Issue filing already refuses team keys for this reason.
- A session-scoped compatibility alias for routes that admit several caller classes at one URL.

TKAI-378 decides whether Security keeps its relational tables. This plan does not change them.
