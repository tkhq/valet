# Instance Config File (`valet.yaml`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/specs/2026-08-14-instance-config-design.md` — a declarative `valet.yaml` loaded at boot: `auth`/`plugins`/`toolPolicies` feed boot-config assembly, `org`/`teams`/`llmProviders`/`skillSources` reconcile into the database.

**Architecture:** A pure loader/validator module in `packages/api/src/config/`, a new `approvalOverrides` option threaded from `NodeProviderOpts` through `EngineHost` into `pluginCatalogTools`, a `reconcileInstanceConfig` boot pass in `packages/api/src/services/`, and a team-bind extension to the provisioning `user.create.after` hook. Makefile and helm wire `VALET_CONFIG`.

**Tech Stack:** TypeScript, vitest, `yaml` package (existing api dep), Drizzle, helm.

## Global Constraints

- No `any`, no `as unknown as T`, no `@ts-ignore` (CLAUDE.md Type safety).
- Every user-facing error message names the corrective action.
- Test filters: `pnpm --filter @valet/<pkg> test <filter>` — NO `--` before the filter.
- Prose in ASD-STE100 style; update the spec's Deviations section if implementation diverges.
- Commit per task, subjects ≤72 chars.
- Exact boot-failure copy is pinned in Task 1 and Task 6 tests — do not reword.

## File map

| File | Role |
| --- | --- |
| `packages/api/src/config/instance-config.ts` (new) | types + `parseInstanceConfig` + `loadInstanceConfig` + `mergeAllowedEmailDomains` |
| `packages/api/src/config/instance-config.test.ts` (new) | loader/validator tests |
| `packages/engine/src/plugin-catalog.ts` | `ApprovalOverrideRule`, glob matcher, `approvalModeFor` override layer |
| `packages/engine/src/plugin-catalog.test.ts` | override tests |
| `packages/api/src/plugins/assemble.ts` | thread `approvalOverrides` into `pluginCatalogTools` |
| `packages/api/src/engine/host.ts` | `EngineHostOptions.approvalOverrides`, pass at `pluginSessionExtras` call sites |
| `packages/api/src/providers/node.ts` | `NodeProviderOpts.instanceConfig`; plugins-filter merge; pass overrides to host |
| `packages/api/src/services/config-reconcile.ts` (new) | `reconcileInstanceConfig` |
| `packages/api/src/services/config-reconcile.test.ts` (new) | reconciler tests |
| `packages/api/src/auth/provisioning.ts` | team bind in `userCreateAfter` |
| `packages/api/src/main.ts` | load config, both-set guards, reconcile pass, boot log |
| `Makefile` | `dev-api-node` exports `VALET_CONFIG` when `config/valet.dev.yaml` exists |
| `deploy/chart/valet/values.yaml`, `templates/instance-config.yaml` (new), `templates/deployment.yaml` | `api.instanceConfig` → ConfigMap → mount + `VALET_CONFIG` |

---

### Task 1: Loader and validator (`instance-config.ts`)

**Files:**
- Create: `packages/api/src/config/instance-config.ts`
- Test: `packages/api/src/config/instance-config.test.ts`

**Interfaces (Produces — later tasks import these exactly):**

```ts
export interface ToolPolicyRule {
  match: string; // glob over qualified tool id "service.action"; "*" matches any chars
  mode: "allow" | "require_approval" | "deny";
}
export interface InstanceMemberDecl { email: string; role: "admin" | "member" }
export interface InstanceConfig {
  version: 1;
  auth?: { allowedEmailDomains?: string[] };
  plugins?: { allow?: string[]; deny?: string[] };
  toolPolicies?: ToolPolicyRule[];
  org?: {
    name?: string;
    features?: Record<string, boolean>;
    modelPreferences?: string[];
    bareSkillCommands?: boolean;
    members?: InstanceMemberDecl[];
  };
  teams?: { name: string; members?: InstanceMemberDecl[] }[];
  llmProviders?: {
    kind: "anthropic" | "openai" | "google" | "openrouter" | "openai_compatible";
    name?: string; // required when kind === "openai_compatible" (validator enforces)
    baseUrl?: string;
    enabled?: boolean;
    models?: { id: string; name?: string }[]; // name defaults to id at reconcile
  }[];
  skillSources?: { repo: string; ref?: string; subpath?: string }[];
}
export class InstanceConfigError extends Error {} // message includes field path + fix
/** Parses + validates YAML text. Throws InstanceConfigError. */
export function parseInstanceConfig(yamlText: string, path: string): InstanceConfig;
/** Reads env.VALET_CONFIG. Unset → null. Missing/unreadable file or invalid content → InstanceConfigError. */
export function loadInstanceConfig(env: NodeJS.ProcessEnv): InstanceConfig | null;
```

Validator rules (hand-rolled, `cli/config.ts` style — no schema library):
- `version` must be exactly `1`: `` `${path}: version must be 1. Set "version: 1".` ``
- Unknown top-level key: `` `${path}: unknown key "${key}". Remove it or check for a typo.` ``
- Every list/enum/string type-checked; on mismatch name the field path (`toolPolicies[0].mode`), the got-value, and the allowed values.
- `mode` ∈ allow|require_approval|deny; member `role` ∈ admin|member; `llmProviders[i].kind` ∈ the five kinds; `openai_compatible` without `name` → error naming the fix.
- Emails: require a non-empty string containing `@` (full RFC validation is not the goal); lowercase+trim on parse.
- `allowedEmailDomains`: lowercase+trim, drop empties (mirror `loadAuthConfig`).

Also produce (used by Task 6):

```ts
/** Both-set guard + merge for allowedEmailDomains. Throws InstanceConfigError with the spec's exact copy when env AUTH_ALLOWED_EMAIL_DOMAINS is set AND cfg.auth?.allowedEmailDomains is present. Returns the domains the caller should use (config value, else env-parsed value passed in). */
export function resolveAllowedEmailDomains(
  cfg: InstanceConfig | null,
  env: NodeJS.ProcessEnv,
  envParsed: string[],
): string[];
```

Exact both-set copy (spec, pinned): `AUTH_ALLOWED_EMAIL_DOMAINS is set and <path> declares auth.allowedEmailDomains. Remove one.` — `<path>` is the `VALET_CONFIG` value.

- [ ] **Step 1: Write failing tests** — cases: valid full file parses (use the spec's illustrative YAML verbatim); minimal `version: 1` parses; version 2 throws with pinned copy; unknown key throws; bad `mode` throws naming `toolPolicies[0].mode`; `openai_compatible` without name throws; `loadInstanceConfig` returns null when `VALET_CONFIG` unset; throws `Config file not found at <path>. Fix VALET_CONFIG or create the file.` for a missing path (use a tmpdir); reads a real tmp file; `resolveAllowedEmailDomains` both-set throws pinned copy, config-only wins, env-only passes through.
- [ ] **Step 2: Run** `pnpm --filter @valet/api test instance-config` — expect FAIL (module not found).
- [ ] **Step 3: Implement** `instance-config.ts` (use `yaml`'s `parse`, `node:fs.readFileSync`).
- [ ] **Step 4: Run the same filter** — expect PASS.
- [ ] **Step 5: Commit** `feat(api): instance config loader and validator`

### Task 2: Engine — approval overrides in the plugin catalog

**Files:**
- Modify: `packages/engine/src/plugin-catalog.ts` (add option; change `approvalModeFor`), `packages/engine/src/index.ts` (export the rule type)
- Test: `packages/engine/src/plugin-catalog.test.ts` (extend existing)

**Interfaces:**
- Consumes: nothing new.
- Produces:

```ts
export interface ApprovalOverrideRule { match: string; mode: ApprovalMode } // structurally identical to api's ToolPolicyRule
export interface PluginCatalogOptions {
  plugins: ActionPlugin[];
  clock?: () => number;
  approvalOverrides?: ApprovalOverrideRule[]; // NEW
}
export function matchesToolPattern(pattern: string, qualifiedId: string): boolean; // exported for tests
```

Semantics (spec, Tool policies): first matching rule wins; no match → existing manifest/riskLevel default. Matching is over `qualifiedId(entry)` (the existing helper: `action.id` if it contains `.`, else `service.action.id`). Glob: `*` matches any run of characters (including `.`); no other metacharacters. Implement by escaping regex specials then replacing `\*` with `.*`, anchored `^…$`. `approvalModeFor(entry, overrides)` checks overrides first.

- [ ] **Step 1: Write failing tests** — `matchesToolPattern` table: (`*`, anything) true; (`github.*`, `github.merge_pull_request`) true; (`github.*`, `linear.create_issue`) false; exact id match; `a.b*c` does not treat `.` in pattern as regex-any (pattern `github.x` must NOT match `githubax`). Catalog-level: build a catalog with a low-risk action (default allow) + rule `{match: "*", mode: "deny"}` → `call_tool` returns the blocked-by-org-policy text; rule `{match: "svc.other", mode: "deny"}` leaves the action allowed; first-match-wins with `[{match: "svc.act", mode: "allow"}, {match: "*", mode: "deny"}]`. Mirror the existing test file's catalog fixture style.
- [ ] **Step 2: Run** `pnpm --filter @valet/engine test plugin-catalog` — expect FAIL.
- [ ] **Step 3: Implement** (thread `opts.approvalOverrides` into the `Catalog` instance; update both `approvalModeFor` call sites).
- [ ] **Step 4: Run same filter** — expect PASS. Also `pnpm --filter @valet/engine test` (whole package) to catch fixture drift.
- [ ] **Step 5: Commit** `feat(engine): approval override rules in plugin catalog`

### Task 3: API threading — overrides + plugins filter merge

**Files:**
- Modify: `packages/api/src/plugins/assemble.ts` (`pluginSessionExtras(plugins, extraSkills?, opts?: { approvalOverrides?: ApprovalOverrideRule[] })`), `packages/api/src/engine/host.ts` (`EngineHostOptions.approvalOverrides?: ApprovalOverrideRule[]`; pass in `sessionExtras` — both `pluginSessionExtras` call sites — and the line-939 plugins use if it builds tools), `packages/api/src/providers/node.ts`
- Test: `packages/api/src/plugins/assemble.test.ts` (extend or create)

**Interfaces:**
- Consumes: `ApprovalOverrideRule` from `@valet/engine` (Task 2), `InstanceConfig` (Task 1).
- Produces: `NodeProviderOpts.instanceConfig?: InstanceConfig`. In `buildNodeProviders`: plugins filter both-set guard — if `opts.instanceConfig?.plugins` is present AND `process.env.VALET_PLUGINS` is set, throw `InstanceConfigError` with `` `VALET_PLUGINS is set and the config file declares plugins. Remove one.` ``; else config's `{allow → allowlist, deny → denylist}` feeds `loadNodeModulesPlugins` in place of `parseValetPluginsEnv`'s result. `opts.instanceConfig?.toolPolicies` flows into `new EngineHost({ ..., approvalOverrides })`.
- [ ] **Step 1: Write failing test** — `pluginSessionExtras(plugins, [], { approvalOverrides: [{match: "*", mode: "deny"}] })` yields a `call_tool` tool whose execution against a known action returns the blocked-by-org-policy text (reuse the fixture plugin style used by existing api plugin tests); and without opts the behavior is unchanged.
- [ ] **Step 2: Run** `pnpm --filter @valet/api test assemble` — expect FAIL.
- [ ] **Step 3: Implement** all three files.
- [ ] **Step 4: Run** the filter, then `pnpm typecheck` — expect PASS.
- [ ] **Step 5: Commit** `feat(api): thread tool policies and plugin filter from instance config`

### Task 4: Reconciler — org, members, invites

**Files:**
- Create: `packages/api/src/services/config-reconcile.ts`
- Test: `packages/api/src/services/config-reconcile.test.ts`

**Interfaces:**
- Consumes: `InstanceConfig` (Task 1); `ensureOrg`, `getOrgFeatures`, `setOrgFeatures`, `setOrgMemberPreferences`? — NO: use `setOrgModelPreferences`, `renameOrg`, `setOrgMemberRole`, `LAST_ADMIN_ERROR` from `services/org.ts`; `invites`, `orgMembers`, `users`, `orgs` tables.
- Produces:

```ts
export interface ReconcileDeps { db: AppDb }
/** Applies org/teams/llmProviders/skillSources. Throws on any failure (boot fails). Idempotent. */
export async function reconcileInstanceConfig(deps: ReconcileDeps, cfg: InstanceConfig): Promise<void>;
export function configInviteId(email: string): string;      // `invite_cfg_` + sha256(email).hex.slice(0,12)
export function configSkillSourceId(repo: string, ref: string, subpath: string): string; // `skillsrc_cfg_` + sha256(`${repo}|${ref}|${subpath}`).hex.slice(0,12)
export function configTeamId(name: string): string;          // `team_cfg_` + sha256(name).hex.slice(0,12)
export function configProviderId(name: string): string;      // `prov_cfg_` + sha256(name).hex.slice(0,12)
```

Org pass logic (this task implements org only; later tasks add the rest inside the same function):
1. `const org = await ensureOrg(db)`.
2. `name` declared → `renameOrg`. `features` declared → merge each key via a direct `orgs.features` read-modify-write (NOT `setOrgFeatures` — it only knows the `organizations` key; write the full merged record, preserving undeclared keys). `modelPreferences` declared → `setOrgModelPreferences`. `bareSkillCommands` declared → direct `db.update(orgs)`.
3. Each member: look up `users` by lowercased email. Exists → if an `org_members` row exists, `setOrgMemberRole` (a `last_admin` result → throw `new Error(LAST_ADMIN_ERROR)`); else insert `{orgId, userId, role, createdAt: Date.now()}`. Not exists → upsert invite row directly: id `configInviteId(email)`, `codeHash: createHash("sha256").update(randomUUID()).digest("hex")` (never redeemable by code; admission matches by email via `findValidInviteByEmail`), `email`, `role`, `createdBy: "config"`, `createdAt: new Date()`, `expiresAt: new Date(Date.now() + 10 * 365 * 24 * 3600_000)`. On conflict (row exists) update `role` + `expiresAt` only when unaccepted (`acceptedBy` null).
4. `invite_cfg_*` rows with `acceptedBy` null whose email is no longer declared → delete.

Note the invites columns are `timestamp` mode — insert `Date` objects, not ms numbers (schema/index.ts `invites`).

Test harness: copy the setup pattern of `packages/api/src/services/skill-sources.test.ts` (in-memory PGlite `AppDb` + migrations). Read that file first and mirror it exactly.

- [ ] **Step 1: Write failing tests** — empty org section is a no-op; features merge preserves an undeclared existing flag; declared member with existing user inserts `org_members`; role change applies; demoting the sole admin throws `LAST_ADMIN_ERROR`; unknown email creates `invite_cfg_*` with role, 10-year expiry; second run is a no-op (same row ids, updatedAt-stable where applicable); removing the email deletes the unaccepted config invite but not an accepted one, and never deletes a UI invite (`invite_<uuid>`).
- [ ] **Step 2: Run** `pnpm --filter @valet/api test config-reconcile` — expect FAIL.
- [ ] **Step 3: Implement the org pass.**
- [ ] **Step 4: Run the filter** — expect PASS.
- [ ] **Step 5: Commit** `feat(api): instance config reconciler — org and members`

### Task 5: Reconciler — teams, llmProviders, skillSources

**Files:**
- Modify: `packages/api/src/services/config-reconcile.ts` (+ its test file)

**Interfaces:**
- Consumes: tables `teams`, `teamMembers` (insert directly — `createTeam` requires a creator, config has none); `createLlmProvider`, `updateLlmProvider`, `listLlmProviders`, `isKnownProviderKind` from `services/llm-providers.ts`; `parseRepoInput`, `newSkillSourceId` NOT needed — insert `skill_sources` rows directly with `configSkillSourceId`; `deleteSkillSource` semantics reproduced by deleting the source row + its `origin='repo'` skills (mirror `deleteSkillSource`'s two deletes, scoped by `sourceId`).

Teams pass (spec, `teams` section):
- Key by name within the org. Missing → insert `{id: configTeamId(name), orgId, name, createdAt}`. Existing (either origin) → adopt, no field updates (name IS the identity).
- Members: resolve email → user; skip + `console.warn` when the user does not exist yet (Task 7 binds at sign-in) or is not an org member. Existing `team_members` row → update role; else insert. Never remove members or teams.

llmProviders pass (spec, `llmProviders` section):
- Known kind: find the org's singleton by kind. Exists → `updateLlmProvider` with declared fields (`name` defaults to the kind; model `name` defaults to model `id`; `enabled` defaults true). Missing → `createLlmProvider`.
- `openai_compatible`: find by `name` among the org's rows. Missing → insert directly with id `configProviderId(name)` (createLlmProvider mints its own id; direct insert keeps the deterministic id). Exists → update declared fields.
- Never delete.

skillSources pass (spec, `skillSources` section — the one destructive section):
- For each entry: `parseRepoInput(entry.repo, { ref: entry.ref, subpath: entry.subpath })`; desired id `configSkillSourceId(repoFullName, ref, subpath)`. Row exists with that id → done. An UNMANAGED row (id not `skillsrc_cfg_*`) already tracks the same `(repoFullName, subpath)` for the org → skip + `console.warn` (spec: never adopt). Else insert an org-owned row (`ownerType: "org"`, `ownerId: orgId`, `status: "pending"`, `nextAttemptAt: Date.now()`, other columns as `createSkillSource` builds them).
- Every `skillsrc_cfg_*` row not among the desired ids → delete it AND its mirrored skills (`skills` where `sourceId` = row id), matching `deleteSkillSource`.

- [ ] **Step 1: Write failing tests** — team created with deterministic id; existing UI team adopted (member added, team id unchanged); member email without user skipped (run succeeds); known-kind provider created then updated on second run with changed models; `openai_compatible` requires name (validator already covers — test reconcile keys by name); declared source inserted org-owned + `pending`; unmanaged duplicate skipped; removing a managed source deletes it and its `origin='repo'` skills; full second run is a no-op.
- [ ] **Step 2: Run** `pnpm --filter @valet/api test config-reconcile` — expect FAIL (new cases).
- [ ] **Step 3: Implement the three passes.**
- [ ] **Step 4: Run the filter** — expect PASS.
- [ ] **Step 5: Commit** `feat(api): reconcile teams, llm providers, skill sources from config`

### Task 6: Provisioning hook — team bind at first sign-in

**Files:**
- Modify: `packages/api/src/auth/provisioning.ts`
- Test: `packages/api/src/auth/provisioning.test.ts` (extend existing)

**Interfaces:**
- Consumes: `InstanceConfig` (Task 1), `configTeamId` (Task 4).
- Produces: `ProvisioningDeps` gains `instanceConfig?: InstanceConfig | null`. In `userCreateAfter`, AFTER the existing `orgMembers` insert: for each `cfg.teams ?? []` entry whose `members` contains the new user's email (lowercased compare), resolve the team by name within `org.id` (`teams` table) and upsert the `team_members` row at the declared role. Team row missing (config edited after boot) → skip silently; the next boot's reconciler recreates it.
- [ ] **Step 1: Write failing test** — mirror the existing provisioning test setup; boot hooks with an `instanceConfig` declaring team "Platform" with the test email as admin; simulate `user.create.after`; assert the `team_members` row exists with role admin; a second user with an undeclared email gets no row.
- [ ] **Step 2: Run** `pnpm --filter @valet/api test provisioning` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the filter** — expect PASS.
- [ ] **Step 5: Commit** `feat(api): bind config-declared team members at first sign-in`

### Task 7: Boot wiring in `main.ts`

**Files:**
- Modify: `packages/api/src/main.ts`, `packages/api/src/auth/config.ts` (no signature change — see below), `packages/api/src/providers/node.ts` (pass-through only, done in Task 3)

Wiring order in `main.ts` (spec, Loading):
1. Top of boot (beside the other env reads): `const instanceConfig = loadInstanceConfig(process.env)` inside a try/catch that prints `err.message` and `process.exit(1)` — fail-loud, no stack spam for config mistakes.
2. `const authConfig = loadAuthConfig(process.env)` stays as-is; immediately after, when `authConfig` is non-null: `authConfig.allowedEmailDomains = resolveAllowedEmailDomains(instanceConfig, process.env, authConfig.allowedEmailDomains)` (also wrapped by the same try/catch pattern). Also pass `instanceConfig` into wherever `buildAuthHooks`' `ProvisioningDeps` is constructed (follow `authConfig` to the `buildAuthHooks` call site — likely `app.ts`/`auth/index.ts` — and thread `instanceConfig` the same way).
3. `buildNodeProviders({ ..., instanceConfig })`.
4. After the existing boot passes, BEFORE `serve`: `if (instanceConfig) await reconcileInstanceConfig({ db: providers.db }, instanceConfig)` — NOT wrapped in a continue-on-error catch (reconcile failure fails boot, unlike `restoreUnsettledSessions`).
5. Boot banner: add a line `config:  ${process.env.VALET_CONFIG ?? "none (VALET_CONFIG unset)"}`.

- [ ] **Step 1: Manual-first check** — run `pnpm --filter @valet/api exec tsx src/main.ts` style boot is heavyweight; instead write a small integration test ONLY if an existing main/boot test harness exists (search `main.test`); otherwise rely on Task 1–6 unit coverage plus Step 3's live check.
- [ ] **Step 2: Implement the wiring.**
- [ ] **Step 3: Live check** — `VALET_CONFIG=config/valet.dev.yaml make dev-api-node` boots; banner shows the path; `VALET_CONFIG=/nope make dev-api-node` exits 1 with the not-found message; with `AUTH_ALLOWED_EMAIL_DOMAINS=x.com` + a config declaring domains + `BETTER_AUTH_SECRET=test…` boot exits with the both-set message.
- [ ] **Step 4: Run** `pnpm typecheck` and `pnpm --filter @valet/api test` — expect PASS.
- [ ] **Step 5: Commit** `feat(api): load and reconcile instance config at boot`

### Task 8: Makefile + dev config

**Files:**
- Modify: `Makefile` (`dev-api-node` target), `config/valet.dev.yaml` (already committed — verify it passes the validator)

In `dev-api-node`, before the `cd packages/api` line's env: `if [ -f config/valet.dev.yaml ] && [ -z "$$VALET_CONFIG" ]; then export VALET_CONFIG="$$(pwd)/config/valet.dev.yaml"; fi;` inside the same shell block (after `.env` sourcing so an explicit `.env` value wins).

- [ ] **Step 1: Implement the Makefile change.**
- [ ] **Step 2: Verify** — `make dev-api-node` boot banner shows the config path; `rm -rf ~/.valet/pg` then reboot restores: org named per file, skill source row present (`curl -s localhost:8788/api/skills/sources -H ...` with local auth, or query PGlite per CLAUDE.md).
- [ ] **Step 3: Commit** `feat(dev): wire config/valet.dev.yaml into make dev-local`

### Task 9: Helm chart

**Files:**
- Modify: `deploy/chart/valet/values.yaml` (add under `api:` → `instanceConfig: ""` with a comment: multiline YAML string, applied via `--set-file api.instanceConfig=config/valet.prod.yaml`)
- Create: `deploy/chart/valet/templates/instance-config.yaml` — `{{- if .Values.api.instanceConfig }}` ConfigMap `<fullname>-instance-config` with `data: { "valet.yaml": {{ .Values.api.instanceConfig | quote }} }` (or `toYaml`/literal block scalar — match the quoting style of `configmap.yaml`)
- Modify: `deploy/chart/valet/templates/deployment.yaml` — when set: volume from that ConfigMap, `volumeMounts` at `/etc/valet` (readOnly), and env `VALET_CONFIG=/etc/valet/valet.yaml` on the api container.

Also: include the config content's checksum as a pod annotation (`checksum/instance-config: {{ .Values.api.instanceConfig | sha256sum }}`) so a config change rolls the Deployment — without it a `helm upgrade` that only changes the ConfigMap never restarts the api and the file is never re-reconciled. Match how sibling templates handle checksums if any exist; add it regardless.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify render** — `helm template deploy/chart/valet --set-file api.instanceConfig=config/valet.dev.yaml | grep -A5 "instance-config"` shows ConfigMap + mount + env + checksum; render WITHOUT the value shows none of them. Run the chart's test suite if `deploy/chart/valet/templates/tests` has one.
- [ ] **Step 3: Commit** `feat(helm): api.instanceConfig ConfigMap and VALET_CONFIG wiring`

### Task 10: Full validation + spec deviations

- [ ] **Step 1:** `pnpm typecheck` clean.
- [ ] **Step 2:** `pnpm --filter @valet/engine test` and `pnpm --filter @valet/api test` clean.
- [ ] **Step 3:** `make e2e` — clean scorecard; name any red row's pre-existing cause.
- [ ] **Step 4:** Update `docs/specs/2026-08-14-instance-config-design.md` — status `implemented`, add a Deviations section for anything that diverged (e.g. exact id-prefix hash inputs).
- [ ] **Step 5: Commit** `docs: mark instance config spec implemented`

## Self-review notes

- Spec coverage: auth (T1/T7), plugins (T3), toolPolicies (T2/T3), org+members+invites (T4), teams (T5/T6), llmProviders (T5), skillSources (T5), loading/fail-loud (T1/T7), Makefile (T8), helm (T9). Open question 2 (SIGHUP re-apply) deliberately unimplemented per spec.
- Type consistency: `ToolPolicyRule` (api) and `ApprovalOverrideRule` (engine) are structurally identical on purpose — the api passes its parsed rules where the engine type is expected without casting.
- The `features` merge uses a direct read-modify-write, NOT `setOrgFeatures`, because the config allows arbitrary feature keys while `OrgFeatures` types only `organizations`.
