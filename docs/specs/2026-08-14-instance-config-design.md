# Instance config file (`valet.yaml`) — design

Date: 2026-08-14
Status: implemented (plan: docs/plans/2026-08-14-instance-config.md)

## Deviations

- `toolPolicies` no longer runs through an engine-side `ApprovalOverrideRule`
  layer. After PR #140 merged the action-policies engine, the reconciler writes
  each rule into `action_policies` as an org policy (`origin: "admin"`,
  `managed_by: "config"`). Rules now declare exactly one of
  service/action/riskLevel instead of a glob `match`.
- The provisioning hook binds config-declared team members by team NAME
  lookup, not by `team_cfg_*` id — the name is the team's identity, so the
  bind works for adopted UI-created teams too. The lookup is additionally
  scoped to `origin = 'config'`: a same-named team the identity provider
  owns is not the file's to write.
- Teams mark ownership with the `teams.origin` column, not an id prefix.
  The prefix cannot survive adoption, and teams are the one table a second
  subsystem also reconciles. See "Ownership marking" below.
- Known-kind llm providers are updated through the existing
  `updateLlmProvider`; only `openai_compatible` rows get deterministic
  `prov_cfg_*` ids (known kinds keep their natural per-org-singleton
  identity).

## Problem

Two kinds of configuration exist today, and only one has a home:

1. **Process configuration** — ports, database URLs, credentials, backend
   selection. Env vars own this, and that is correct: these values differ
   per machine and often hold secrets.
2. **Instance state** — which org exists, which features are on, who the
   members are, which repositories feed the skill library. This lives only
   in the database. Nothing declares it.

The second kind causes two recurring problems:

- **Dev DB wipes lose everything.** Pre-1.0 we edit migrations in place and
  wipe `~/.valet/pg` instead of migrating. Every wipe re-requires manual
  bootstrap: re-enable the `organizations` feature flag, re-add skill
  sources, re-invite members.
- **Dev and prod drift.** The same instance state must be re-created by hand
  in each environment. There is no file to diff, review, or apply.

## Thesis

**Env vars configure the process. `valet.yaml` configures the instance.**

A single YAML file declares the desired instance state. The api reads it at
boot and reconciles the database to match, idempotently. A wiped dev DB
self-heals on the next boot. Dev and prod each point at a checked-in file,
so the difference between them is a `git diff`, not tribal knowledge.

The file never holds secrets. Credentials stay in env vars and the
encrypted credential store.

## Alternatives considered

- **Seed script (`make bootstrap`)** — a one-shot script that POSTs to the
  API after a wipe. Rejected: it drifts from the routes it calls, it needs
  auth plumbing, and it does not converge prod (it only seeds empty DBs).
- **Extend `~/.valet/config.json`** — the CLI config already exists.
  Rejected: that file is per-developer-machine and unversioned by design.
  Instance state must be checked in and shared.
- **Helm values as the source of truth** — put instance state in
  `values.yaml` and template it into env vars. Rejected: dev does not run
  helm, so this syncs nothing, and env vars are a poor encoding for lists
  of structured objects.

## File format

YAML, versioned, one file per environment. Proposed layout:

```
config/
  valet.dev.yaml    # applied by `make dev-local`
  valet.prod.yaml   # applied by the helm chart (ConfigMap)
```

```yaml
# config/valet.prod.yaml (illustrative)
version: 1

auth:
  allowedEmailDomains: [turnkey.io]   # replaces AUTH_ALLOWED_EMAIL_DOMAINS

plugins:
  allow: [plugin-github, plugin-linear]   # replaces VALET_PLUGINS; or `deny:`

toolPolicies:
  - action: "github.merge_pull_request"   # one target: service | action | riskLevel
    mode: deny
  - service: "linear"
    mode: allow
  - riskLevel: critical
    mode: require_approval
    appliesIn: session                     # optional; default "any"

org:
  name: Turnkey
  features:
    organizations: true
    ssoTeamSync: true                      # off unless declared; the file
                                           #   then wins over Settings at
                                           #   every boot
  modelPreferences:
    - anthropic/claude-opus-4
  bareSkillCommands: true
  members:
    - email: test@valet.test
      role: admin

teams:
  - name: Platform
    members:
      - email: test@valet.test
        role: admin

llmProviders:
  - kind: anthropic              # known kinds are per-org singletons
    models:
      - id: claude-opus-4
  - kind: openai_compatible
    name: local-vllm
    baseUrl: http://vllm.internal:8000/v1
    models:
      - id: qwen-coder

skillSources:
  - repo: obra/superpowers      # owner/repo on github.com
    ref: main                   # optional; omitted = default branch
    subpath: skills             # optional; omitted = repository root

mcpServers:
  - name: salesforce            # action service; tools appear as salesforce.<tool>
    url: https://mcp.example.com/mcp
    auth: oauth                 # none | oauth | api_key | bearer
  - name: internal-docs
    url: https://mcp.internal.example/mcp
    auth: bearer
    tokenEnv: INTERNAL_DOCS_MCP_TOKEN   # secret stays in the environment
```

Top-level keys in v1:

| Key            | Type   | Consumed by                                        |
| -------------- | ------ | -------------------------------------------------- |
| `version`      | number | must be `1`; anything else fails boot              |
| `auth`         | object | boot config assembly (`loadAuthConfig` merge)      |
| `plugins`      | object | boot config assembly (plugin filter)               |
| `toolPolicies` | list   | DB reconciler → `action_policies` (org policies)   |
| `org`          | object | DB reconciler → `orgs`, `org_members`, `invites`   |
| `teams`        | list   | DB reconciler → `teams`, `team_members`            |
| `llmProviders` | list   | DB reconciler → `llm_providers`                    |
| `skillSources` | list   | DB reconciler → `skill_sources` (org-owned)        |
| `mcpServers`   | list   | boot config assembly (synthesized MCP plugins)     |

Every key except `version` is optional, and so is every subfield —
`org: { features: { organizations: true } }` alone is a valid file. An
absent key means "this file does not manage that value" — the reconciler
does not touch those tables and boot-config assembly falls back to the env
var or default.
Unknown top-level keys fail validation (typo protection), matching the
warn-and-drop precedent in `cli/config.ts` but stricter, because a silently
dropped section here means silently missing state.

### Why YAML

The repo already standardized on YAML for declarative files
(`plugin.yaml`, `.valet/prebuild.yaml`, helm values) and the `yaml` package
is already a dependency of `packages/api`. JSON forbids comments;
environment files need comments.

## Loading

- `VALET_CONFIG` (env var) points at the file.
- Unset → no file → boot proceeds exactly as today. The feature is opt-in.
- Set but the file is missing or unreadable → **fail boot**:
  `Config file not found at <path>. Fix VALET_CONFIG or create the file.`
- Parse or validation error → **fail boot** with the field path and the
  corrective action. A half-applied config is worse than no api.

Validation is a hand-rolled narrow validator in
`packages/api/src/config/instance-config.ts`, following the
`cli/config.ts` pattern. No new schema library; the shape is small.

The file has two consumers, so `main.ts` loads and validates it **before**
`loadAuthConfig`:

1. **Boot config assembly** reads `auth` and `plugins` — these shape the
   process (admission rule, plugin registry filter) and cannot wait for a
   DB pass.
2. **The DB reconciler** reads `org`, `teams`, `llmProviders`,
   `skillSources`, and `toolPolicies` after `buildNodeProviders`.

### Migrated env vars

`auth.allowedEmailDomains` replaces `AUTH_ALLOWED_EMAIL_DOMAINS`;
`plugins.allow`/`plugins.deny` replace `VALET_PLUGINS`. The env vars keep
working for deployments without a config file. Setting the same value in
both places **fails boot**:
`AUTH_ALLOWED_EMAIL_DOMAINS is set and <path> declares auth.allowedEmailDomains. Remove one.`
Two live sources of truth for admission policy is silent-drift territory;
better to make the operator pick.

`auth.sso.teams` replaces the three team-sync claim names —
`AUTH_OIDC_TEAM_CLAIM`, `AUTH_OIDC_TEAM_ASSERTED_CLAIM` and
`AUTH_OIDC_TEAM_ADMIN_GROUP`. They qualify on every test above: non-secret,
identical across replicas, and they change the shape of instance state. The
both-set guard is **per field**, not per section, because the three are
independent and an operator may reasonably move two into the file and leave
the third in the environment.

```yaml
auth:
  sso:
    teams:
      claim: groups                   # AUTH_OIDC_TEAM_CLAIM
      assertedClaim: groups_asserted  # AUTH_OIDC_TEAM_ASSERTED_CLAIM
      adminSubGroup: admins           # AUTH_OIDC_TEAM_ADMIN_GROUP
      groups: [/platform, /research]  # the allowlist; no env equivalent
```

`groups` is the allowlist. It names every group that may become a team, and
it gives the validator the one thing a runtime check cannot have: the set of
team names the identity provider will ask for, before any row exists.

The file is one of two writers. The list itself lives on the org row
(`orgs.sso_team_groups`), where an org admin edits it per group in Settings →
Organization → Teams and the login sync reads it per login. When the file
declares `groups`, the boot reconciler writes the file's list over the column
at every start and prints one line naming the file when the value changes —
the same file-wins rule as `org.features`. A deployment that wants the list
managed in Settings leaves the key out of the file.

It is optional in the YAML and fail-closed at run time. Omit it and the sync
mirrors NOTHING — not every group, which was the earlier behaviour. The two
readings differ only for a deployment that named no group, and that
deployment cannot have decided which of its provider's groups are Valet
teams. An identity provider carries `/everyone`, `/vpn-users` and groups from
projects that ended years ago, and no rule can separate those from the ones
an operator wants; the claim-name defaults match Keycloak's stock mapper, so
"mirror everything" was reachable with no file at all. Nothing is silently
stopped by the change, because team mirroring itself is now off unless
`org.features.ssoTeamSync` is set (`docs/specs/2026-07-14-auth-v2-design.md`);
an operator who turns that on lists the groups in the same edit. The api
prints one boot line when the gate is on and the list is empty.

Taking a group OFF the list stops mirroring that group; it deprovisions
nobody. The sync filters its removal set by the list as well as its desired
set, so a de-listed team keeps its members and everything it owns, and one
boot line names it. See `docs/specs/2026-07-14-auth-v2-design.md`, "The list
gates writes, not removals".

The validator rejects four shapes that would otherwise be inert or unsafe at
run time, none of which produces a visible symptom: a `claim` equal to
`assertedClaim` (which collapses the absent-versus-empty test the sync's
whole safety property rests on), a `/` inside `adminSubGroup` (ambiguous
paths — see `docs/environment-variables.md`), a `groups` entry that is not a
top-level path (the sync mirrors nothing deeper), and a blank value. The
run-time side now demands the same rooted shape of the claim: a group name
with no leading `/` is ignored, because it cannot be told from a nested group
of the same name.

Values that stay in env vars: everything with a secret sibling (OIDC
issuer/client/secret, `BETTER_AUTH_SECRET`) and everything genuinely
per-deployment (`AUTH_TRUSTED_ORIGINS`, ports, database URLs,
`VALET_SANDBOX_IMAGE`, backend selection).

## Reconciliation

A new boot pass, `reconcileInstanceConfig`, in
`packages/api/src/services/config-reconcile.ts`. `main.ts` calls it after
`buildNodeProviders` and before `serve`, alongside the existing boot
passes (`restoreUnsettledSessions` etc.). Unlike those passes, a reconcile
failure **fails boot** — the operator relies on this state existing,
especially right after a dev wipe.

The reconciler is idempotent: running it twice against the same file and
database is a no-op the second time.

### Ownership marking — deterministic ids, no schema change

Config-created rows carry a recognizable id prefix instead of a new
`managed_by` column:

- skill sources: `skillsrc_cfg_<sha256(repo|ref|subpath)[:12]>`
- invites: `invite_cfg_<sha256(email)[:12]>`

The reconciler owns exactly the rows matching these prefixes. UI-created
rows (`skillsrc_<uuid>`, `invite_<uuid>`) are never touched. This keeps the
pre-1.0 schema edits to zero for this feature.

**Teams are the exception, and use a column.** `teams.origin` already exists
with values `local | idp`, because the identity-provider team sync needs to
know which rows it owns. Teams gain a third value, `config`, rather than a
second, parallel provenance mechanism. Two reasons make the column
unavoidable here where a prefix suffices elsewhere:

1. A prefix cannot survive adoption. The reconciler adopts a same-named
   team created in the UI, which keeps its original id — so the id can never
   answer "who owns this row" for exactly the rows where the question
   matters. `configTeamId` still mints `team_cfg_<hash>` for a team the
   reconciler creates, because a legible id is free, but nothing keys on it.
2. A third writer already exists. Teams are the one table two subsystems
   reconcile, and the rule that keeps them apart has to be readable by both.

`invites` and `skill_sources` keep their prefixes. There the prefix IS the
prune predicate, it works, and changing it would mean a schema edit plus a
rewrite of two prune loops for no gain. The repo already runs both
conventions side by side — `skills.origin` is `local | repo` while
`skill_sources` config rows are prefix-marked. That inconsistency predates
this file and is deliberately left alone.

### `org` section

The instance is single-org today (`ensureOrg` in `services/org.ts`). The
reconciler calls `ensureOrg`, then:

- **`name`, `features`, `modelPreferences`, `bareSkillCommands`** —
  overwritten from the file on every boot. The file is the source of truth
  for the fields it declares; a UI edit to a declared field lasts until the
  next boot. Feature keys merge through `setOrgFeatures` (partial update),
  so flags the file does not name keep their DB value — the merge is against
  the raw jsonb, so a key this build does not name survives a write from the
  settings page too.

  Two feature keys are typed today: `organizations` and `ssoTeamSync`. Each
  reads as false when absent, which is what makes a gate default to off for
  an operator who declares nothing. `ssoTeamSync` turns identity-provider
  groups into teams — see `docs/specs/2026-07-14-auth-v2-design.md`.

  A declared flag is also STICKY in two ways the settings page does not show.
  The file wins at every boot, so a flag an admin turns off in Settings comes
  back at the next api restart; and the merge only adds, so a value written
  once survives the key being deleted from the file. `reconcileOrgPass`
  therefore prints one line naming the file for each declared flag whose value
  it changes, and prints nothing when the file and the database agree. A
  deployment that wants a flag controlled from Settings must not declare it.
  `config/valet.dev.yaml` keeps `ssoTeamSync` commented out for the same
  reason: `make dev-local` loads that file for every dev.
- **`members`** — desired memberships, keyed by email:
  - Email matches an existing user → upsert the `org_members` row to the
    declared role. A demotion that would leave the org with zero admins
    fails reconcile (and boot) with the existing last-admin message.
  - No user with that email yet → upsert a config-managed invite
    (`invite_cfg_*`, email-bound, declared role, 10-year expiry). The
    existing admission rule (`evaluateAdmission`, rule 2: valid invite by
    code or email) then admits them with the right role at first sign-in.
    The invite rule runs before the domain rule, so a declared admin whose
    email domain is also allowlisted gets the invite's admin role, not a
    domain-rule member downgrade. No new admission path.
  - An email removed from the file → its unaccepted `invite_cfg_*` row is
    deleted. An existing membership is **not** removed — removal of a real
    member is a destructive act that stays in the UI. The reconciler logs
    the divergence instead.

Under `VALET_LOCAL_AUTH=1` the stub identity is seeded independently
(`seedLocalIdentity`) and is unaffected; the win in dev is `features` and
`skillSources` surviving the wipe.

**With an SSO IdP (Keycloak):** `members` is expected to be small or
absent. `auth.allowedEmailDomains` admits everyone the IdP authenticates
on the org's domain, always as `member`; the `members` list is then only
the declarative admin grants. An "admit any SSO-authenticated user"
option (no domain list) does not exist today and is out of scope here —
it would be a new auth-config option, not a file concern.

### `teams` section

A team's identity is its name — `teams` has a unique (org, name) index, so
the reconciler keys by name and no id-prefix marking is needed:

- A declared team that does not exist → created with `origin: config` (id
  `team_cfg_<hash>` for traceability; identity remains the name).
- A declared team that exists with `origin: local` → adopted **and promoted
  to `config`**. After adoption the file is what asserts that team's members
  at every boot, so a row left at `local` would make `origin` answer the
  wrong question for every reader of it — the teams-page badge, the delete
  guard, a future rename route.
- A declared team that exists with `origin: idp` → **fails boot.** See
  "Collisions with the identity-provider sync" below.
- A team that `origin` says is `config` but the file no longer declares →
  **demoted back to `local`**, members intact. That is a release of
  ownership, not a destruction, so it stays inside "assert, don't destroy".
  It also makes `origin` recomputed state the reconciler owns, which is the
  only way it stays true across edits to the file. An absent `teams:` key
  means this instance does not manage teams and nothing is demoted; an empty
  `teams: []` is a declaration of none, and demotes all.
- **`members`** — same email semantics as `org.members`: an existing user
  is upserted into `team_members` at the declared role. A declared member
  with no user yet is bound by the provisioning hook at first sign-in —
  after admission, the hook checks the loaded config for team declarations
  matching the new user's email. (Org membership needed the invite table
  because admission itself gates on it; team membership does not gate
  sign-in, so a post-admission bind suffices.)
- The section only asserts. It never deletes a team or removes a member —
  those stay UI actions; the reconciler logs divergence.

The API keeps membership on a `config` team editable, and refuses only
DELETE (`ConfigManagedTeamError`, 409). Refusing membership edits would be
stricter than this section's own rule: the file adds and never removes, so a
UI addition survives every boot and a UI removal survives until the next
restart. A delete is the one change the file cannot express — the next boot
recreates the team empty, which reads as data loss. The teams page therefore
keeps the member controls on a declared team, drops the delete item, and
shows a note that a restart puts the declared members back.

#### Collisions with the identity-provider team sync

Teams are reconciled by two subsystems: this file at boot, and
`services/team-sync.ts` at every single-sign-on login. The invariant that
keeps them apart is one sentence:

> A team's `origin` names exactly one writer of its `team_members` rows.

`config` rows are written only by the teams pass and by the first-sign-in
bind, and neither ever deletes. `idp` rows are written only by the sync,
which adds, changes role, and removes — removal is what offboarding means.
`local` rows are written only by the teams routes. No row has two writers,
so no membership has two opinions, and nothing can oscillate.

Without that scope the two passes flap. The reconciler would find an `idp`
team by name, adopt it, and assert the declared members onto it; the next
login would remove every one of them that the group claim omits; the next
boot would add them back. One write per restart, one per sign-in, forever.

Both sources want a name — `teams[].name: platform` and a group `/platform`
— is therefore an error, never a merge. It is caught in three places, in
this order:

1. **Statically, in the validator**, when `auth.sso.teams.groups` is
   declared. The check is **case-insensitive** although `teams_org_name` is
   not, and that is the point: `Platform` and `/platform` do NOT collide in
   Postgres, so they would create two rows that read as one team in the
   teams page. A near-collision nobody can see is worse than one that fails
   loudly. Making the index case-insensitive instead would be a migration
   plus a behavior change for teams that already exist.
2. **At boot, in the reconciler**, when a declared name is already held by
   an `origin: idp` row. This is the ordering that loses data — the group
   was mirrored first, then somebody added the team to the file — so the api
   refuses to start and names both fixes.
3. **At run time, in the sync**, for a group the file never listed. The sync
   skips the group and leaves the declared team untouched
   (`name_taken_by_config_team`). Skipping loses a team nobody has yet;
   adopting would lose access people already have. It is also the rule the
   sync already applies to `local` teams — *the sync never takes over a team
   it did not create* — rather than a second rule.

The corrective action differs per origin, so `reportCollision` switches
exhaustively on it. The `local` branch's advice ("rename or delete that
team") is wrong for a `config` team and would loop: delete it, the next boot
recreates it, the same warning returns.

### `llmProviders` section

Non-secret provider shape only — `kind`, `name`, `baseUrl`, `models`,
`enabled`. API keys stay in the credential store (or the existing
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` env handling); a declared provider
without a connected credential reconciles fine and waits for its key,
same as one created in the UI.

This section exists because `org.modelPreferences` references namespaced
model ids (`{kind|rowId}/{modelId}`) that point at provider rows — after
a wipe, a preference with no declared provider points at nothing. Declare
both and the pair survives together.

- **Known kinds** (`anthropic`, `openai`, `google`, `openrouter`) are
  per-org singletons — the kind is the identity. The reconciler adopts
  the existing row or creates it, then overwrites the declared fields.
  `name` defaults to the kind.
- **`openai_compatible`** entries require a `name`; the reconciler keys
  them by name and creates missing rows as `prov_cfg_<hash>`.
- The section only asserts; it never deletes a provider row. (Deletion
  has service-level guards — the org default model's provider refuses to
  delete — and stays in the UI.)

Declared sources are org-owned (`owner_type='org'`). For each entry the
reconciler upserts a `skillsrc_cfg_*` row; the existing `SkillSyncService`
poller picks it up like any other source — the config file feeds the
subsystem, it does not replace it.

- A `skillsrc_cfg_*` row whose (repo, ref, subpath) no longer appears in
  the file → deleted through the existing delete path, which also deletes
  the mirrored `origin='repo'` skills (mirror semantics, per
  `services/skill-sources.ts`).
- The same repo+subpath already tracked by an *unmanaged* row for the same
  owner → skip and log. The reconciler does not adopt or fight rows a
  human created.
- Repo addresses are validated with the same parser the route uses
  (`parseRepoInput`), so the file rejects the same inputs the UI rejects.

### `mcpServers` section

Declares remote MCP servers the instance exposes as action services,
without a plugin package per server. Boot synthesizes one `ValetPlugin`
per enabled entry (`packages/api/src/plugins/config-mcp.ts`) around the
same `mcpActionPlugin` seam the bundled MCP plugins use
(`packages/sdk/src/mcp/action-plugin.ts`). The entry therefore inherits
every existing surface: dynamic tool discovery, the connect UI
(`/api/plugins`), MCP OAuth dynamic registration, tool policies, and
approvals. This section is boot-assembled, not DB-reconciled — the plugin
set is in-memory process state, so there is no row to converge.

```yaml
mcpServers:
  - name: salesforce            # required; lowercase slug; the action service
    displayName: Salesforce CRM # optional; connect-UI card title
    url: https://mcp.example.com/mcp   # required; http(s) MCP endpoint
    auth: oauth                 # required; none | oauth | api_key | bearer
    scopes:                     # oauth only: scopes for the authorize request
      - crm:read
    tokenEnv: SF_MCP_TOKEN      # bearer only: env var that holds the token
    authQueryParam: API_KEY     # api_key/bearer only: send token as query param
    connectLabel: Acme API key  # api_key only: connect-UI copy
    description: CRM tools      # optional
    riskLevel: medium           # optional; default medium
    enabled: true               # optional; false parks the entry
```

Auth modes:

- **`none`** — no credential. The server's tools are visible to every user.
- **`oauth`** — per-user MCP OAuth against `url` (RFC 8414 discovery +
  RFC 7591 dynamic registration, PKCE). Each user connects in the
  integrations UI, exactly like the bundled Linear plugin. `scopes` go
  into the authorize request. Declare them for a scope-gated server:
  Metabase, for one, grants a token with no scopes when the request names
  none — the server does not fall back to the registered client's default
  scope set — and then lists zero tools with no error anywhere. A
  connected zero-scope credential cannot be upgraded by refresh; the user
  must disconnect and reconnect after scopes are added.
- **`api_key`** — per-user manual token entry in the connect UI.
- **`bearer`** — one instance-wide token, read from `tokenEnv` at boot.
  The file never holds secrets, so the entry names the env var. A `bearer`
  entry whose env var is unset or blank fails boot with the var named.
  There is no connect flow; every user can use the tools.

Rules:

- `name` is the action service: tools surface as `<name>.<tool>`, and
  tool policies target them the same way. Names must be unique in the file.
- A `name` that collides with another plugin's service fails boot in
  `assemblePlugins`, naming both plugins. Synthesized plugin names carry a
  `mcp-config:` prefix so a config entry can never silently dedupe against
  a bundled plugin.
- Mode-specific keys on the wrong mode fail validation (`tokenEnv` outside
  `bearer`, `scopes` outside `oauth`, `connectLabel` outside `api_key`,
  `authQueryParam` outside `api_key`/`bearer`).
- `displayName` is the human-readable name the connect UI shows as the
  card title (and in the default `connectLabel` for `api_key` entries).
  When absent, the synthesized plugin title-cases `name`
  ("grafana-cloud" → "Grafana Cloud"). The wire carries it as
  `PluginSummary.displayName`; the web client prefers it over its own
  id-derived label.
- `riskLevel` is the per-service default. Explicit MCP tool annotations
  override it per tool: `readOnlyHint: true` → `low`;
  `destructiveHint: true` → `critical`; `destructiveHint: false` with
  `idempotentHint: true` → `medium`; `destructiveHint: false` with
  `openWorldHint: true` → `high`. Hints override in both directions:
  `riskLevel` is the assumption for unannotated tools, not a cap or a
  floor, so a `low` default does not hold an open-world write at `low`.
  Absent hints never move risk — the MCP
  spec defaults (`destructiveHint: true`, `openWorldHint: true`) are not
  assumed, because an unannotated tool would otherwise surface as
  `critical`. The mapping lives in `deriveRiskLevel`
  (`packages/sdk/src/mcp/action-plugin.ts`).

## Tool policies

`toolPolicies` declares org-level action policies. The reconciler writes each
rule into the `action_policies` table — the same engine that backs UI-managed
policies. See docs/specs/2026-07-16-action-policies-audit-design.md for the
policy engine.

Each rule declares exactly one target and a mode:

```yaml
- action: "github.merge_pull_request"   # one of: service | action | riskLevel
  mode: deny                            # allow | require_approval | deny
  appliesIn: any                        # optional; any | session | workflow
```

- **Target** — set exactly one of `service`, `action`, or `riskLevel`. Zero
  targets or more than one is a boot error that names the field. `action` is
  the fully-qualified `service.action` id (the policy engine's `actionId`).
  `riskLevel` is one of `low`, `medium`, `high`, `critical`.
- **`mode`** is required: `allow`, `require_approval`, or `deny`.
- **`appliesIn`** is optional and defaults to `any`. Use `session` or
  `workflow` to scope the rule to one invocation context.
- **Reconciliation** — the reconciler upserts one `action_policies` row per
  declared target, `origin: "admin"`, `managed_by: "config"`, keyed by a
  deterministic `pol:config:<hash>` id. Re-running boot is idempotent.
- **Removal is a soft-revoke.** A rule dropped from the file stamps
  `revoked_at` on its managed row instead of deleting it, so the action log
  keeps the provenance. Re-declaring the rule clears `revoked_at`.
- **UI-created policy rows are never touched** by the reconciler — only rows
  with the `pol:config:` id prefix.

Precedence is the policy engine's, not this file's. An org `deny` is absolute:
neither a live runtime grant nor a per-user override can loosen it. Grants and
personal overrides interact with these rows exactly as the action-policies
design specifies. A rule with no matching invocation falls through to the
plugin's `defaultApprovalMode`, then the `riskLevel` default.

## Dev and prod wiring

**Dev** — `make dev-local` exports `VALET_CONFIG=$(PWD)/config/valet.dev.yaml`
when that file exists. After `rm -rf ~/.valet/pg`, the next boot restores
the org flags, pending invites, and skill sources with no manual steps.

**Prod (helm)** — the chart gains `api.instanceConfig` (string). When set,
the chart renders it into a ConfigMap, mounts it at
`/etc/valet/valet.yaml`, and sets `VALET_CONFIG` on the api Deployment.
Deploys pass the checked-in file:

```bash
helm upgrade ... --set-file api.instanceConfig=config/valet.prod.yaml
```

A config change is then a PR that edits `config/valet.prod.yaml`, and
"what differs between dev and prod" is
`diff config/valet.dev.yaml config/valet.prod.yaml`.

## Failure modes

| Failure                                   | Behavior                                        |
| ----------------------------------------- | ----------------------------------------------- |
| `VALET_CONFIG` set, file missing          | Boot fails; message names the path and fix      |
| YAML parse error / unknown key / bad type | Boot fails; message names the field and fix     |
| Reconcile DB write fails                  | Boot fails; the config is desired state         |
| Env var and file both declare a migrated value | Boot fails; message says which one to remove |
| Demotion would remove the last admin      | Boot fails with the last-admin message          |
| Declared source duplicates an unmanaged row | Skipped and logged; boot continues            |

## Security notes

1. **Write access to the config is a privilege boundary.** Write access to
   the `VALET_CONFIG` file (or the Helm ConfigMap that renders it) equals
   org-admin plus control of the approval policy. Gate it like a secret:
   whoever can edit this file can grant themselves admin, add skill sources,
   and disable approval gates.
2. **A broad `toolPolicies` allow can disable approval org-wide.** An `allow`
   rule downgrades an action whose plugin default or `riskLevel` demands
   approval. A wide target — `riskLevel: critical, mode: allow`, or a
   high-traffic `service` allow — turns off the approval gate for every action
   it covers. Review `toolPolicies` changes with the same care as an RBAC
   change.
3. **SSO sign-ins ignore `auth.allowedEmailDomains`.** An SSO/IdP sign-in is
   admitted regardless of the domain list (existing auth-v2 behavior). The
   domain list bounds email and social signup only. To bound who the IdP can
   admit, configure the IdP, not this file.
4. **Declared `org.members` roles reassert on every boot.** A UI demotion of
   a declared member is overwritten at the next boot, because the file is the
   source of truth for the roles it declares. To stop managing a member's
   role from the file, remove that member from the file.

## Non-goals (v1)

- **Multi-org.** The file mirrors today's single-org model. When multi-org
  lands, `org:` becomes `orgs:` with a list — the version field exists for
  that break.
- **Secrets or env interpolation.** No `${VAR}` substitution. Credentials
  stay in env vars and the credential store.
- **Moving further env vars into the file.** v1 migrates exactly two
  (`AUTH_ALLOWED_EMAIL_DOMAINS`, `VALET_PLUGINS` — see Migrated env vars).
  Everything else stays where it is until a concrete need appears.
- **Image sources / bakes.** The reconcile design
  (2026-08-02) already auto-creates repo sources on bind; declaring extra
  image sources here can come later if a need appears.
- **A `valet config apply` CLI.** Boot-time reconcile covers the stated
  need; a manual apply command is additive later.

## Open questions

1. Should `org.members` also *demote* by omission (file lists no role for
   an existing admin)? v1 says no — the file only asserts what it declares.
2. Does prod want reconcile-on-SIGHUP or a `/api/admin` re-apply endpoint
   instead of restart-to-apply? Deferred until it hurts.
3. Should `teams[]` gain an explicit stable key (`id:`) so a rename in the
   file tracks the same row? Under name-as-identity, renaming a team in the
   file today orphans the old row and creates a second team beside it. That
   is a real gap, but name-as-identity was a deliberate choice and changing
   it is wider than the collision work that prompted the question. The door
   stays open at zero cost: `teams_org_external` is keyed on
   `(org_id, origin, external_id)`, so `external_id` is already a
   per-origin namespace that such a key could occupy without colliding with
   the group paths the sync stores there. Until then `external_id` is NULL
   for a `config` team — the file identifies a team by `teams[].name`, which
   `teams_org_name` already keeps unique, and a second column holding a copy
   of the first would buy no constraint.
4. Should `auth.sso.teams.groups` become required in the YAML? Not in v1. It
   is already required in effect: an absent list mirrors nothing, so the
   failure is a no-op rather than a surprise, and `org.features.ssoTeamSync`
   is the gate an operator sets deliberately. A `version: 2` could make the
   pair — gate on, list empty — a boot error instead of a boot warning.
