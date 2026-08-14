# Instance config file (`valet.yaml`) — design

Date: 2026-08-14
Status: proposed

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
# config/valet.dev.yaml
version: 1

org:
  name: Turnkey
  features:
    organizations: true
  members:
    - email: me@connerswann.me
      role: admin

skillSources:
  - repo: obra/superpowers      # owner/repo on github.com
    ref: main                   # optional; omitted = default branch
    subpath: skills             # optional; omitted = repository root
```

Top-level keys in v1:

| Key            | Type   | Reconciles into                          |
| -------------- | ------ | ---------------------------------------- |
| `version`      | number | must be `1`; anything else fails boot    |
| `org`          | object | `orgs`, `org_members`, `invites`         |
| `skillSources` | list   | `skill_sources` (org-owned)              |

Every key except `version` is optional. An absent key means "this file does
not manage that section" — the reconciler does not touch those tables.
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

### `org` section

The instance is single-org today (`ensureOrg` in `services/org.ts`). The
reconciler calls `ensureOrg`, then:

- **`name`, `features`** — overwritten from the file on every boot. The
  file is the source of truth for the fields it declares; a UI edit to a
  declared field lasts until the next boot. Feature keys merge through
  `setOrgFeatures` (partial update), so flags the file does not name keep
  their DB value.
- **`members`** — desired memberships, keyed by email:
  - Email matches an existing user → upsert the `org_members` row to the
    declared role. A demotion that would leave the org with zero admins
    fails reconcile (and boot) with the existing last-admin message.
  - No user with that email yet → upsert a config-managed invite
    (`invite_cfg_*`, email-bound, declared role, 10-year expiry). The
    existing admission rule (`evaluateAdmission`, rule 3: valid invite by
    email) then admits them with the right role at first sign-in. No new
    admission path.
  - An email removed from the file → its unaccepted `invite_cfg_*` row is
    deleted. An existing membership is **not** removed — removal of a real
    member is a destructive act that stays in the UI. The reconciler logs
    the divergence instead.

Under `VALET_LOCAL_AUTH=1` the stub identity is seeded independently
(`seedLocalIdentity`) and is unaffected; the win in dev is `features` and
`skillSources` surviving the wipe.

### `skillSources` section

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
| Demotion would remove the last admin      | Boot fails with the last-admin message          |
| Declared source duplicates an unmanaged row | Skipped and logged; boot continues            |

## Non-goals (v1)

- **Multi-org.** The file mirrors today's single-org model. When multi-org
  lands, `org:` becomes `orgs:` with a list — the version field exists for
  that break.
- **Secrets or env interpolation.** No `${VAR}` substitution. Credentials
  stay in env vars and the credential store.
- **Moving existing env vars into the file.** `AUTH_ALLOWED_EMAIL_DOMAINS`,
  `VALET_PLUGINS`, and friends are candidates for later versions, but v1
  does not relocate anything that already works.
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
