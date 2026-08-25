# Workflows 1.0 MVP: Repository-Scoped Definitions and the Remaining Gaps

**Date:** 2026-08-24
**Status:** Proposed
**Scope:** Two halves of the largest 2026-08-24 engineering item. Half 1 makes a workflow definition a file a team keeps in its own repository: a `.valet` folder that carries workflow definitions and workflow templates, mirrored into Postgres by the repository sync rail that already serves skills, armed on a push, and read-only inside the product. Half 2 states what "1.0 MVP" means for workflows beyond that sync, as a checklist that marks every documented gap ship or defer, so the team can tell when workflows are done. Everything targets the v2 stack (`packages/api`, `packages/workflow`, `packages/web`, `packages/engine`). Team credential execution is a stated dependency on `docs/specs/2026-08-24-team-credentials-and-workflow-bootstrap-design.md` and is not solved here.

## Context

### The sync rail already exists, and it is not a workflow rail yet

Repository-synced skills ship. One tracked repository is a `skill_sources` row (`packages/api/src/schema/index.ts:855-909`, `packages/api/migrations/pg/0000_app.sql:497`), owned by a user, a team, or the org. Every skill it mirrors is a `skills` row carrying `origin='repo'`, `source_id`, `upstream_path`, and `content_sha` (`schema/index.ts:804-828`). The schema comment at `schema/index.ts:799-801` says the ownership columns mirror `workflow_definitions` deliberately, because both follow one access rule: your own rows plus the rows of every team you belong to.

The sweep is `SkillSyncService` (`packages/api/src/services/skill-sync.ts:304`), started at boot (`packages/api/src/main.ts:347`) and constructed at `packages/api/src/providers/node.ts:608`. It never clones. It reads GitHub through four REST operations defined by `SkillRepoReader` (`packages/api/src/services/skill-repo-reader.ts:334-344`): the head commit of a ref, one recursive tree, one directory listing, and one file. Change detection is two cheap compares. The first reads the head commit and stops when it equals `last_sha`, at a cost of one API call. The second hashes a manifest of the tracked files keyed by their git blob shas, which the tree read already carried, so it runs before any file body is read (`skill-sync.ts:22-40`, `:288-296`). Every read after the first compare is pinned to the commit the first compare resolved.

The claim loop is a single-statement compare-and-set (`claimDueSkillSources`, `skill-sync.ts:247-269`) with the same fence the event dispatcher uses. A healthy source polls every `SYNC_INTERVAL_MS = 15 * 60_000`; the sweep ticks every `POLL_MS = 60_000` and claims `BATCH = 10` (`skill-sync.ts:159-170`). There is no push trigger today.

The rules that make the rail safe are worth naming, because this design inherits all of them. A transport failure on any tracked file fails the whole sync and reconciles nothing, so a GitHub outage does not read as "every file was deleted upstream" (`skill-sync.ts:78-81`). A file discovery found and the sync could not read makes the pass incomplete, so neither the commit nor the manifest hash is recorded and the next poll re-reads it (`:82-88`). A cut tree that forced the narrower directory walk reports `deleted: 0` unconditionally, because a narrower scan's absences prove nothing (`:738-746`). Deletes are scoped by `source_id` and `origin='repo'` twice (`:749-760`).

Which GitHub credential a sync uses is the whole tenancy rule, deliberately kept in one file (`packages/api/src/services/skill-source-credential.ts:1-70`). A user source reads with that user's own credential. A team source reads with the credential of the user in `created_by`. An org source reads with the org's GitHub App installation token. Every check is re-run on every sync, not at creation, so a creator who leaves the team stops funding the read. Every failure falls to an anonymous read and never climbs, and neither call ever passes `auth: "auto"`, because the auto ladder would let a source reach the org App.

Discovery is pure path rules over a tree listing (`packages/api/src/services/skill-discovery.ts`). A skill is a blob named exactly `SKILL.md`; a prompt is a `.md` blob whose immediate parent is `prompts`. Any dot-prefixed ancestor is excluded, with exactly one exception written as a single constant: `const SCANNED_DOT_DIRECTORY = ".claude"` (`skill-discovery.ts:128`). So `.valet` is excluded from discovery today by one line.

### `.valet` is already a repository convention, read by three unrelated paths

`.valet/prebuild.yaml` configures a repository's sandbox image and is read over the GitHub Contents API with no clone (`packages/api/src/prebuilds/recipe.ts`, probed at `packages/api/src/bakes/source-service.ts:322-357`). `docs/specs/2026-08-03-prebuild-cache-management-design.md:11` calls it "the per-repo customization surface". `/workspace/.valet/prompts/*.md` becomes slash commands, read from the prepared sandbox rather than the API (`packages/api/src/engine/command-providers.ts:29-52`). `/workspace/.valet/persona` is written by the frozen runner. No path reads a workflow out of `.valet`, and no design document describes one.

### Workflow storage has no repository seam

`workflow_definitions` (`schema/index.ts:917-931`, `0000_app.sql:524`) holds `id`, `org_id`, `owner_type`, `owner_id`, `name`, `definition` as jsonb, and timestamps. There is no unique name index, no `origin` column, no `source_id`, and no path column. `workflow_versions` (`schema/index.ts:935-946`) snapshots a definition per save and is keyed unique on `(workflow_id, version)`; it has no owner columns because reads join through the definition. `createWorkflowDefinition` mints the row and snapshots version 1 (`packages/api/src/workflows/service.ts:257-302`). `updateWorkflowDefinition` writes the row and snapshots a version only when the definition hash changed, so a rename alone mints nothing (`service.ts:384-430`, hash at `packages/api/src/workflows/definition-version.ts`). `deleteWorkflowDefinition` refuses while a run is unsettled and otherwise removes the definition, its versions, its schedules, its targeting event subscriptions, and its webhook (`service.ts:673-719`).

One repository-shaped route exists. `GET /api/workflows/import/repo-file` (`packages/api/src/routes/workflows.ts:298-380`) reads one file out of a public repository, using `parseRepoInput` from the skill sources service and `GitHubSkillRepoReader` itself. Its own doc comment records that it passes no credential and that this is "a gap, not a rule" (`routes/workflows.ts:245-252`). It returns text and leaves parsing to the client, so the two import sources cannot drift. The client parser is JSON-only and refuses anything else by name (`packages/web/src/components/workflows/import-workflow.ts:57-63`). There is no export: `routes/workflows.ts` has no export handler, and `packages/web/src/components/workflows/` has no download control.

Templates are code only. `WorkflowTemplate` is defined in `packages/engine/src/workflow-template.ts:87-147` and composed from engine-owned types, with `definition` left `unknown` on purpose. Templates come from plugin manifests and from a host catalog (`packages/api/src/workflows/templates.ts:106-189`), and a repeated id throws. There is no template table anywhere in `schema/index.ts`, and the only two template routes are `GET /api/templates` and `POST /api/templates/:id/install` (`packages/api/src/routes/templates.ts:44`, `:54`).

### The push path is already built and already verified

`GITHUB_EVENT_TYPES` starts with `push` (`packages/plugin-github/src/triggers.ts:3-19`), and the App manifest subscribes to every registered trigger event (`packages/api/src/routes/github-app.ts:278-285`, `:316`). The App holds `contents: "write"` (`routes/github-app.ts:319-328`). The webhook endpoint verifies the HMAC signature, handles installation events locally, and forwards every other event into the generic pipeline through `ingestEvent` (`routes/github-app.ts:736-753`). A subscription whose target names a workflow starts a run whose id derives from the delivery row, so a retry resolves to the same run (`packages/api/src/events/dispatcher.ts:230-250`). A push subscription can filter only on `repo` and `sender`; there is no branch filter and no changed-path filter (`packages/plugin-github/src/triggers.ts:132-135`), and the matcher rejects any filter naming an undeclared field.

### Team-owned execution is the blocker the sync inherits

`credentialOwnerFor` maps a run owner onto a credential owner for users and orgs, and returns null for a team (`packages/api/src/plugins/action-invoker.ts:550-555`). The template install path already refuses a team install of a template that has both a schedule and tool nodes, with code `unsupported_owner`, because "a scheduled run bills the workflow's owner ... and a team principal has no credential scope" (`packages/api/src/workflows/templates.ts:802-815`). `docs/specs/2026-08-24-team-credentials-and-workflow-bootstrap-design.md` decision 13 removes that refusal. Until it lands, any team-owned workflow that a schedule or an event fires cannot resolve credentials for its tool nodes.

### Deployment facts that bound this work

There is no continuous deployment. `.github/workflows/` holds continuous integration, image publishing, chart and CLI releases, and a remote-Postgres job; none of them deploy. `docs/kubernetes.md:241` opens a "Not Implemented Yet" section that includes remote-cluster deploy automation, and rollout is a manual `helm upgrade`. The chart runs one api replica (`deploy/chart/valet/values.yaml:9`), which is what keeps the per-process webhook rate limiter correct for now. Pre-1.0 the repository edits `0000_app.sql` in place and recreates the development database, per `CLAUDE.md`.

## Decisions

### Half 1 — repository-scoped workflows

**1. One sync rail, parameterized by content kind, rather than a second implementation.** `skill_sources` becomes `content_sources` and gains a `kinds` jsonb column holding a subset of `["skills", "workflows", "templates"]`, defaulting to `["skills"]`. `SkillSyncService` becomes `ContentSyncService`. Nothing about the sweep changes: the same claim statement, the same backoff ladder, the same two compares, the same credential rule.

The alternative was a parallel `workflow_sources` table with its own service. It is rejected for three reasons. The credential rule in `skill-source-credential.ts` is the security-critical part of this feature, and a second copy doubles the surface where a privilege escalation can appear. A repository tracked for both skills and workflows would otherwise call GitHub twice per interval for the same head commit, and an anonymous read of a public repository is limited to sixty calls an hour. And the four failure rules quoted in Context — outage reconciles nothing, an unread file makes the pass incomplete, a narrowed scan deletes nothing, deletes are scoped twice — are behaviors this repository got right once, at some cost, and a copy will drift from them.

The accepted cost is a table rename, a service rename, and a change to the shipped skills settings page. Pre-1.0 the migration is edited in place, so the rename is a text edit plus `rm -rf ~/.valet/pg`.

**2. A collector interface separates the generic sweep from the per-kind rules.** `ContentCollector` lives in `packages/api/src/services/content-sync/collector.ts` and declares a `kind`, a pure `discover(entries, source)` over a tree listing, and an optional `walkDirectory` for a commit whose tree GitHub cut. `discover` returns a `CollectorPass`: what this collector found at this commit, with the async `reconcile(context)` that writes the rows bound to it. The sweep resolves the credential once, compares the head commit, reads one tree, asks every enabled collector to discover, hashes one manifest over the union of what they found, reads the file bodies they asked for, and then calls each collector's reconcile. One manifest hash over all kinds means a repository that changed only its README skips every collector after one tree read.

The existing skill rules move behind `SkillCollector` with no behavior change. The proof is that `packages/api/src/services/skill-sync.test.ts` moves with them and passes with import-path edits only.

**3. `.valet` is opened to discovery, and the folder contract is fixed.** `SCANNED_DOT_DIRECTORY` (`skill-discovery.ts:128`) becomes `SCANNED_DOT_DIRECTORIES`, a set holding `.claude` and `.valet`. Everything else about the exclusion rule stays: `.github`, `.vscode`, and `.venv` remain unscanned, and `EXCLUDED_DIRECTORIES` is untouched.

Three roots carry workflow content:

- `.valet/workflows/**` holds workflow definitions. This is the folder the 2026-08-24 call described as replacing `.github` for Valet automation.
- `.valet/templates/**` holds workflow templates.
- A top-level `workflows/**` also holds workflow definitions, for a repository whose authors do not want a dot folder. This is the second folder the call named, and it matches the example path the existing import route already prints, `workflows/deploy.json` (`routes/workflows.ts:306`).

Nested directories under a root are allowed, because a large repository will want `.valet/workflows/billing/monthly-invoice.yaml`. A workflow's identity is its path, never its directory name. Accepted extensions are `.yaml`, `.yml`, and `.json`. A file sitting directly in `.valet/` is ignored, which keeps the collector away from `.valet/prebuild.yaml` and `.valet/persona`.

**4. One file envelope, YAML or JSON, parsed by one shared module.** A workflow file is an envelope with a discriminator:

```yaml
valet: workflow/v1
name: Nightly triage
description: Sweeps open issues and posts a summary.
definition:
  nodes: [ ... ]
  edges: [ ... ]
schedule:
  name: Nightly
  cron: "0 3 * * *"
  timezone: UTC
  description: Every day at 03:00 UTC
events:
  - name: On push
    eventKeys: [github.push]
    filters: [{ field: repo, op: eq, value: acme/service }]
    description: When someone pushes to the service repository
```

A template file uses `valet: workflow-template/v1` and adds the `WorkflowTemplate` fields the gallery renders: `id`, `category`, `apps`, `steps`, and the optional `rank`, `icon`, and `caveats` (`packages/engine/src/workflow-template.ts:87-147`).

The discriminator does real work. Under a top-level `workflows/` folder a file without a `valet:` key is ignored in silence, because that folder belongs to the repository and may hold anything. Under `.valet/workflows/` a file without the key produces a warning naming the path, because that folder is unambiguous.

YAML is accepted and is the documented default, because a hand-authored definition wants comments and multi-line prompt text. JSON stays valid, because YAML 1.2 parses JSON. The `yaml` package is already a dependency of `packages/api` (`packages/api/package.json:88`). The `definition` value then goes through `validateDefinitionInput` (`packages/api/src/workflows/service.ts:103`) with the full validation environment (`packages/api/src/workflows/validation-env.ts`), so a file that names an unknown model or an unknown tool service fails at sync with the validator's own messages rather than at run time inside a node.

The envelope rules live in `packages/workflow/src/file.ts` as `parseWorkflowFileValue(value, path)`, which takes an already-parsed value and adds no text decoder. `packages/api` composes it with `yaml.parse`. `packages/web` already depends on `@valet/workflow` (`packages/web/package.json:26`) and composes it with `JSON.parse`, falling back to a dynamically imported `yaml` chunk only when a pasted file is not JSON, so the main web bundle grows by nothing. This makes literal the rule that `import-workflow.ts:1-10` states as an intention: one parser reads every source, and a second one cannot drift.

**5. A mirrored workflow is a row keyed by its path, owned by its source.** `workflow_definitions` gains `origin` (`local` or `repo`, defaulting to `local`), `source_id`, `upstream_path`, and `content_sha`, with a unique index on `(source_id, upstream_path)`. `workflow_versions` gains nullable `origin` and `source_commit`, so version history shows which commit produced a version.

Identity is `(source_id, upstream_path)` and nothing else. Not the name, and not any id the file writes. Renaming a file therefore deletes one workflow and creates another, which is the honest reading of a rename in a system with no rename event, and the run history of the old path stays where it is.

A mirrored row copies `owner_type` and `owner_id` from its source row. A team source produces team-owned workflows, and an org source produces org-owned workflows. A user source does not collect workflows at all, following the 2026-08-24 decision that personal workflow sync is out of scope. A user source that holds workflow files records one notice: the files were skipped, repository workflow sync applies to team and org sources, and adding the repository as a team source syncs them.

Every mirrored write goes through the existing `snapshotVersion` path, so a repository edit and a product edit produce entries in one version timeline.

**6. A mirrored workflow is read-only in the product, and copying is the escape hatch.** `updateWorkflowDefinition` refuses when `origin === 'repo'`, with 409 and a message naming the file and the repository: edit the file and push. Every product write path funnels through that one function — the REST route, the `workflows.update_workflow` agent action (`packages/api/src/workflows/actions.ts:254`, `:575`), and `addAggregateNode` — so one guard covers all of them. `deleteWorkflowDefinition` refuses on the same rows, because deleting the file is the delete.

"Repo wins" is therefore true by construction, and there is no lost-edit case to resolve: the product never held the edit. `POST /api/workflows/:id/copy` creates a `local` duplicate named `<name> (copy)` for the person who wants to change the graph inside the product; the mirrored original stays in place and keeps syncing.

A file never adopts, overwrites, or deletes a `local` workflow, including one with the same name. `workflow_definitions` has no unique name index (`schema/index.ts:917-931`), so two workflows may share a name, and the list badges every mirrored row with `owner/repo:path` so the two are told apart.

**7. Deletion is a set reconcile, and an unsettled run disarms instead of deleting.** A path that leaves the tree deletes its definition, its versions, its schedules, its targeting event subscriptions, and its webhook — the same cleanup `deleteWorkflowDefinition` performs at `service.ts:673-719`. Every delete is scoped by `source_id` and `origin='repo'`, twice, exactly as the skills reconcile does at `skill-sync.ts:749-760`. A transport failure reconciles nothing. A narrowed directory-walk scan reports `deleted: 0`.

One exception. When the workflow has an unsettled run (`pending`, `running`, `parked`, or `terminalizing`), the sync does not delete it. It disables the schedules, deletes the event subscriptions and the webhook so that nothing new starts, keeps the definition row, and warns naming the workflow. The next sync retries the delete once the runs settle. This reuses the reasoning behind the `has_active_runs` guard and needs no new column.

**8. Triggers declared in the file are armed with the definition; webhooks are not.** A `schedule` block writes a `workflow_schedules` row and an `events` block writes `event_subscriptions` rows, both reconciled with the definition, so removing a block from the file disarms the trigger. The install path's validation order is reused: the cron expression is parsed before the write (`templates.ts:875-891`) and each subscription passes `validateSubscription` before the write (`:899-957`), so a bad cron or an undeclared filter field fails the file and reports on the source row instead of arming a trigger that can never fire.

A webhook is never created from a file. The bearer secret is the primary key of `workflow_webhooks` (`schema/index.ts:1512-1521`), so a file that declared one would publish the secret in the repository. Arm a webhook from the Triggers UI against the mirrored workflow; it survives resyncs because it keys off `workflow_id`.

**9. The team-credential gate is copied from the install path, and it is deleted with it.** A team-owned mirrored definition that has tool nodes and declares a schedule or events is mirrored, and its triggers are left unarmed, and the source records a warning naming the reason. This is exactly the `unsupported_owner` rule at `templates.ts:802-815`, applied at sync time rather than at install time. Org-owned sources are unaffected, because `credentialOwnerFor` returns an owner for `org` (`action-invoker.ts:550-555`) and org-credential escalation already works (merged as #381).

When `docs/specs/2026-08-24-team-credentials-and-workflow-bootstrap-design.md` decision 13 removes the install refusal, this gate is removed in the same commit, and a resync arms the triggers. Until then, a team can keep its workflows in a repository and run them by hand, and it cannot run them on a schedule.

**10. Adding workflow collection to a source needs administrative authority over the owner.** Push access to a tracked repository becomes authority to run tool nodes as that team or that org. This is the same bargain GitHub Actions makes, and it is the point of the feature, so the control is who may create the source. Creating a team source whose `kinds` include `workflows` or `templates` requires `canAdministerTeam` (`packages/api/src/services/teams.ts:443`). Org sources already require an org admin (`packages/api/src/routes/skills.ts:617-627`). A plain member may still add a skills-only team source, exactly as today. The refusal names the corrective action: ask a team admin, or add the repository as a skills source.

**11. A repository template is a mirrored row; who can see it follows the source's owner scope.** A new `workflow_templates` table holds `id`, `org_id`, `owner_type`, `owner_id`, `template_id`, `origin`, `source_id`, `upstream_path`, `content_sha`, the `template` jsonb, and timestamps, unique on `(org_id, owner_type, owner_id, template_id)` and on `(source_id, upstream_path)`.

`listCatalogTemplates(plugins)` stays pure and code-only. A new `listCatalogTemplatesForOwner(deps, owner)` concatenates the code catalog with the mirrored rows the caller can reach — the org's rows and the rows of every team they belong to — in that order, so a shipped template always outranks a mirrored one that claims its name. A mirrored `template_id` that collides with a code catalog id is refused at sync with a warning naming both, because we ship one side and the repository owns the other, and the collision must be loud where it can be fixed rather than at boot.

There is one template file format. Whether a mirrored template is an org template or a team template is decided by the owner scope of the source that mirrored it, and by nothing in the file. An org source publishes to the whole org's gallery; a team source publishes to that team. Open templates stay code-shipped in plugin manifests and in `template-definitions.ts`, and a public repository added as an org source in another deployment makes the same file an open template there. This is the mapping of the call's "open templates and org templates both definable in the repo" onto the tenancy model the product already has.

Installing a mirrored template runs the unchanged `installWorkflowTemplate`, so the installed copy is a `local` workflow the installer may edit. That is the difference between the two file kinds, and it is worth stating plainly: a template is a starting point that is copied when someone installs it, and a definition is a live mirror the product cannot edit.

**12. A push marks sources due; polling stays the floor.** The GitHub App webhook already receives verified `push` deliveries (`routes/github-app.ts:733-753`). Before it forwards one to `ingestEvent`, it calls `providers.contentSync.onPush(orgId, repositoryFullName, ref, defaultBranch)`. That call sets `next_attempt_at` to now on every enabled source in the org whose `repo_full_name` matches and whose tracked ref matches, then nudges the sweep. A source with an empty `ref` matches `refs/heads/<default_branch>` from the payload.

`onPush` reads nothing from the payload into content. The sync then re-reads GitHub under the source's own credential, so a forged payload can at worst cost one extra poll. It never syncs inline, so a push storm collapses into one sync per source per `POLL_MS` tick.

An `event_subscriptions` row was considered and rejected. A subscription's workflow target starts a run and bills it (`events/dispatcher.ts:230-250`), and sync is infrastructure rather than a workflow. A subscription could not scope to a branch either, because `push` declares only `repo` and `sender` filters (`plugin-github/src/triggers.ts:132-135`).

A repository without the org's GitHub App installed sends no push. Those sources keep the fifteen-minute poll and the "Sync now" button.

**13. Non-repository workflows need no new persistence.** `workflow_definitions` is a Postgres table with no time-to-live and no sweeper. The only real risk is the pre-1.0 rule that edits `0000_app.sql` in place and recreates the development database, which loses workflows written on a developer's machine before a schema edit. The answer to that is the export path in decision 14 plus the repository sync itself, not object storage. No S3, no new table, no migration beyond the columns decisions 5 and 11 add.

**14. Export closes the loop.** `GET /api/workflows/:id/file?format=yaml|json` returns the decision-4 envelope, and the editor gains a Download control. Without it, "keep your workflows in the repository" means writing YAML by hand for a graph the editor already holds. Round trip is the acceptance test: export a product workflow, commit it under `.valet/workflows/`, and the sync mirrors the same graph.

This is a synchronous read of a definition, so it does not use the `artifacts` table and share-link route that landed with #395. Those store a produced file; this renders a row.

### Half 2 — what 1.0 MVP means for workflows

Workflows are ready for 1.0 when three things are true. A team can keep its automation in a repository and get it back after any deployment change. Anyone can see what every run produced without opening each one. And a run that was going to fail on its input fails at the trigger with a readable message rather than deep inside the graph.

The checklist below covers every gap the existing workflow specs record as not done. Each line says ship or defer, and names who carries it.

| # | Gap and where it is recorded | Verdict | Carrier and reason |
|---|---|---|---|
| 1 | Repository-scoped workflows and templates; no spec existed | Ship | This spec, decisions 1-12. |
| 2 | No workflow export (`routes/workflows.ts` has no export handler) | Ship | This spec, decision 14. Repository authoring is unusable without it. |
| 3 | Latest run result on the workflows list | Ship | PR #389, already open. This spec stacks the origin badge on it. |
| 4 | No paging control in the run list; lists show a `+` suffix (`2026-08-10-workflow-batch-fanout-design.md`) | Ship | This spec. `GET /api/workflows/runs` already returns a cursor (`routes/workflows.ts:220`); a cursor with no control is a defect, not a deferral. |
| 5 | No index on `workflow_runs` creation order (batch fan-out spec, "measure first") | Ship | This spec. Item 4 makes that ordering the hub's default query, so the measurement is done. |
| 6 | Webhook, schedule, and event payloads are not validated against `dataSchema` (`2026-07-16-workflows-overhaul-design.md`, 2026-08-14 addendum) | Ship | Separate task on the triggers owner. A repository author never runs their workflow by hand, so an unvalidated trigger payload becomes the normal failure mode. |
| 7 | `docs/specs/workflows.md` still documents the legacy executor (`workflows.md:12`) | Ship | This spec. It is the document a repository author reads before writing a file, so a stale reference is now actively harmful. |
| 8 | Team-owned scheduled workflows cannot resolve credentials (`action-invoker.ts:550-555`) | Blocked | `2026-08-24-team-credentials-and-workflow-bootstrap-design.md`. This spec ships the gate in decision 9 and deletes it when that spec lands. |
| 9 | Wave concurrency fixed at five (`packages/workflow/src/interpreter.ts:601`) | Defer | Nothing has reached the limit, and a per-workflow knob needs a schema field nobody has asked for. |
| 10 | Error edges, a distinct on-failure branch (batch fan-out spec, decision 3) | Defer | `onError: 'fail' \| 'continue'` on tool, llm, and workflow nodes covers the MVP need (`packages/workflow/src/dag/nodes.ts:97-105`). |
| 11 | No `onError` on a `foreach` node (`nodes.ts`) | Defer | `onItemError: 'fail' \| 'skip' \| 'collect'` covers per-item failure, which is the case that occurs. |
| 12 | Run status is polled every five seconds; no push transport | Defer | The batch fan-out spec shows this is a transport build, not a fix: `BusEvent` is keyed by `sessionId` and a run has no session. It belongs to the workflows UI overhaul. |
| 13 | Per-org limit overrides on `orgs.features` (batch fan-out spec) | Defer | The instance-wide `VALET_ORG_SESSION_CEILING` shipped (commit `3e52fd69`) and one deployment serves one org today. |
| 14 | Sub-workflow runs create no `agent_sessions` row and bypass the org ceiling | Defer | Their `session` and `orchestrator` nodes still create counted sessions, so the ceiling is loosened rather than bypassed. Closing it needs run identity, which is a separate design. |
| 15 | No per-owner fairness in the run-host claim loop | Defer | Needs an owner-aware `listRunnable`. One org per deployment cannot starve itself. |
| 16 | Attention rate limiting for a large batch (batch fan-out spec, decision 7) | Defer | `maxItems` bounds a batch (`packages/workflow/src/nodes/foreach.ts:121`), and the external-runner shape that fans out is opt-in. |
| 17 | Webhook rate limiter is per-process | Defer | The chart runs one api replica (`deploy/chart/valet/values.yaml:9`). Revisit with the first multi-replica deployment. |
| 18 | No version restore or rollback (no such symbol in `service.ts`) | Defer | Git is the rollback for a mirrored workflow. A local workflow keeps its version list as read-only history. |
| 19 | Event-trigger filters are a raw JSON textarea (`2026-08-15-workflow-triggers-ui-design.md`) | Defer | The filter vocabulary is still growing; a builder written now would be rewritten. |
| 20 | No client-side cron preview | Defer | Needs a cron library in the web bundle for a convenience the schedule description already provides. |
| 21 | A trigger's target kind is immutable | Defer | Delete and recreate is a two-click workaround. |
| 22 | Template gallery rebuild (batch fan-out spec, out of scope) | Defer | Decision 11 adds mirrored rows to the existing gallery. The rebuild is a UI project. |
| 23 | Workflow `task` node (`2026-08-24-tasks-design.md:69`) | Defer | Owned by the tasks spec, which ships the `onTaskSettled` hook first. |

## Reconciliation with in-flight work

**#389, `feat/workflows-latest-run-result`, open draft, web only.** It adds a `LatestRunLine` component and a `runResultSnippet` helper to `packages/web/src/routes/workflows.index.tsx` and removes the per-row status chip. This spec defers to it. Task 10 below stacks the repository badge and the paging control on the same file after #389 merges, and it does not reimplement the latest-run line. If #389 stalls, the badge lands first and #389 rebases; the two changes touch different rows of the same list item.

**#388, merged 2026-08-20, jsonb double-parse fix.** It stopped `pg-store.ts` and `credential-store.ts` from parsing an already-parsed top-level jsonb string. Mirrored definitions are jsonb read through the same helpers, so this spec builds on the fix and adds no new read helper. Without it, a definition whose top level serialized as a string would come back wrong on the first sync.

**#386, merged 2026-08-20, Slack identity enrichment.** It stamps the run owner's linked Slack id onto a resolved Slack credential, for user owners only. A team-owned mirrored workflow therefore gets a bare bot token on its Slack nodes. This spec changes nothing about that and cites it as further support for decision 9's gate: a team-owned mirrored workflow that posts to Slack works on a public channel and fails on a private one.

**#381, merged 2026-08-19, org-credential escalation.** It made the invoker escalate to an org-provided service credential. This is what makes an org-owned mirrored workflow useful on day one while team-owned ones wait for the team-credentials spec, and it is why decision 9 gates teams only.

**#394, merged 2026-08-23, sandbox Tier-0.** Workflow sessions are now sandbox-less by default, with `warmSandboxOnClaim: false` and a sandbox provisioned lazily on the first filesystem tool. A repository-authored workflow is the first graph nobody clicked through before it ran, so the exit criteria below include a mirrored workflow whose `session` node touches the filesystem, to prove lazy provisioning works from that path.

**#395, merged 2026-08-23, artifacts and share links.** It added the `artifacts` table and a read-only `/a/{token}` route. Decision 14 deliberately does not use it: workflow export renders a row synchronously and stores nothing. Named here so a reader does not wire the two together.

**#383, `restore-per-user-model-preferences`, open.** It edits `packages/api/src/engine/host.ts` and `packages/api/migrations/pg/0000_app.sql`. There is no logical overlap with this spec, and there is a textual conflict in the migration file, which several open branches now share. Whoever lands second re-applies their own table edits; nothing about the semantics changes.

**#396 (Valet Design), #398 (staged files), #399 (sandbox file upload), #397 (its spec).** All four are unrelated to workflow storage. #396 and #398 also edit `0000_app.sql`, so the same textual-conflict note applies. #399's upload route is the file-ingestion path the business-workflows spec wanted, and it is not needed here; note that its web wiring is incomplete on the branch, so the CLI is its only entry point today.

**#151, `feat/rbac-permissions`, open and stale since 2026-07-30.** It carries the unlanded `docs/specs/2026-07-21-team-resources-design.md`. Decision 10 uses the direct `isTeamMember` and `canAdministerTeam` checks, the same choice `2026-08-24-team-credentials-and-workflow-bootstrap-design.md` makes. If #151 lands, the gate becomes a `can(…, { teamId })` call in one place, and nothing else about this design moves.

**#392, `security/single-line-fixes`, open.** It touches `repos/host.ts` among other files. No overlap; a rebase is the whole interaction.

**#163, `feat/onepassword-credentials`, open and stale since 2026-07-22.** A different 1Password design from the one in `2026-08-24-onepassword-credential-broker-design.md`. It does not touch workflow storage or the sync rail, so it neither blocks nor is blocked by this spec.

**No continuous deployment exists.** This feature reaches an environment through a manual `helm upgrade`, and the pre-1.0 migration rule recreates the development database. The dogfood in the exit criteria assumes a manual rollout and states the database reset as a step, rather than assuming a pipeline that `docs/kubernetes.md:241` says is not built.

## Implementation plan

Tasks are ordered, and each is one commit. Schema edits go into `packages/api/migrations/pg/0000_app.sql` and `packages/api/src/schema/index.ts` in place, and every task that edits them ends with `rm -rf ~/.valet/pg` before its tests run.

**1. Generalize the sync rail with no behavior change.** Rename `packages/api/src/services/skill-sync.ts` to `packages/api/src/services/content-sync/service.ts`, exporting `ContentSyncService`. Create `packages/api/src/services/content-sync/collector.ts` holding the `ContentCollector` interface and the shared manifest and reconcile context types. Move the current skill rules — `readManifest` (which the interface splits into `discover` and `walkDirectory`), `reconcile`, `insertMirror`, `updateMirror`, `parseSkillFile`, `parsePromptFile` — into `packages/api/src/services/content-sync/skill-collector.ts` behind that interface. Rename `skill_sources` to `content_sources` in `packages/api/migrations/pg/0000_app.sql:497` and `packages/api/src/schema/index.ts:855`, add `kinds jsonb NOT NULL DEFAULT '["skills"]'`, and rename `packages/api/src/services/skill-sources.ts` to `content-sources.ts` and `skill-source-credential.ts` to `content-source-credential.ts`. Update `packages/api/src/providers/types.ts:77`, `packages/api/src/providers/node.ts:608-636`, and `packages/api/src/main.ts:347` and `:508`.
Test: move `packages/api/src/services/skill-sync.test.ts` to `packages/api/src/services/content-sync/skill-collector.test.ts` and change only its import paths. Every existing case must pass unaltered; that is the no-behavior-change proof. Run `pnpm --filter @valet/api test content-sync`.

**2. Open `.valet` to discovery.** Modify `packages/api/src/services/skill-discovery.ts:128`: replace `SCANNED_DOT_DIRECTORY` with `SCANNED_DOT_DIRECTORIES: ReadonlySet<string> = new Set([".claude", ".valet"])` and update the ancestor test that reads it. Update the comment at `:44-47` that names the skipped dot directories.
Test: extend `packages/api/src/services/skill-discovery.test.ts` with a `.valet/skills/deploy/SKILL.md` that is discovered, a `.github/skills/x/SKILL.md` and a `.venv/.../SKILL.md` that are still not, and a `.valet/prebuild.yaml` that is not a candidate of any kind. Run `pnpm --filter @valet/api test skill-discovery`.

**3. The workflow file envelope and the shared parser.** Create `packages/workflow/src/file.ts` exporting `parseWorkflowFileValue(value, path)`, `WorkflowFile`, `WorkflowTemplateFile`, `WORKFLOW_FILE_EXTENSIONS`, and the two `valet:` kind strings; export them from `packages/workflow/src/index.ts`. Modify `packages/web/src/components/workflows/import-workflow.ts` to call the shared parser and to fall back to a dynamically imported `yaml` chunk when a pasted file is not JSON, keeping the two legacy shapes it accepts today (`import-workflow.ts:38-45`).
Test: create `packages/workflow/src/file.test.ts` covering an envelope round trip, back-compatibility for a bare definition and for `{ name, definition }`, an unknown `valet:` value refused by name, a template envelope, and a bad graph whose errors are the validator's own text. Extend `packages/web/src/components/workflows/import-workflow.test.ts` with a pasted YAML envelope. Run `pnpm --filter @valet/workflow test file` and `pnpm --filter @valet/web test import-workflow`.

**4. Workflow mirror columns and the read-only guard.** Modify `packages/api/src/schema/index.ts:917-946` and `packages/api/migrations/pg/0000_app.sql:524-546`: add `origin`, `source_id`, `upstream_path`, and `content_sha` to `workflow_definitions` with a unique index `workflow_definitions_upstream` on `(source_id, upstream_path)`; add nullable `origin` and `source_commit` to `workflow_versions`; add index `workflow_runs_owner_created` on `(owner_type, owner_id, created_at DESC)`. Modify `packages/api/src/workflows/service.ts:384` and `:673` to refuse a repo-origin row with a new `RepoOwnedWorkflowError` from `@valet/shared` whose message names the file and repository, and add `copyWorkflowDefinition`. Modify `packages/api/src/routes/workflows.ts` to map that error to 409 and to add `POST /:id/copy`. Modify `packages/api/src/wire/types.ts` so `WorkflowDefinitionSummary` carries `origin` and the upstream reference.
Test: create `packages/api/src/workflows/service.repo-origin.test.ts` — an update 409s with the path in the message, the agent-action path 409s through the same guard, a delete 409s, and a copy produces a `local` row holding the same graph. Extend `packages/api/src/workflows/service.delete-cleanup.test.ts` so a local delete is unchanged. Run `pnpm --filter @valet/api test service.repo-origin service.delete-cleanup`.

**5. The workflow collector.** Create `packages/api/src/services/content-sync/workflow-collector.ts`: discovery over `.valet/workflows/**` and `workflows/**` with the decision-3 extension and discriminator rules, envelope parsing through the shared module composed with `yaml.parse`, validation through `validateDefinitionInput` with `packages/api/src/workflows/validation-env.ts`, insert and update and delete keyed by `(source_id, upstream_path)`, a version snapshot carrying `source_commit`, the unsettled-run disarm path, the user-source skip notice, and the decision-9 team gate. Register it in the sweep for sources whose `kinds` include `workflows`.
Test: create `packages/api/src/services/content-sync/workflow-collector.test.ts` against the fixture server `packages/api/src/services/skill-repo-reader.test.ts` already uses. Cover: two files import; editing one adds a version row carrying the new commit; deleting one removes the definition, its versions, and its triggers; a transport failure reconciles nothing; a cut tree deletes nothing; a workflow with an unsettled run is disarmed rather than deleted and is deleted on the next sync after the run settles; a user-owned source skips workflow files with the notice; a team-owned source with tool nodes and a schedule mirrors the definition and leaves the schedule unarmed. Run `pnpm --filter @valet/api test workflow-collector`.

**6. Trigger arming from a file.** Extend `packages/api/src/services/content-sync/workflow-collector.ts` to reconcile `workflow_schedules` and `event_subscriptions` with the definition, reusing the cron parser and `validateSubscription` the install path calls (`packages/api/src/workflows/templates.ts:875-891`, `:899-957`).
Test: extend the collector test — adding a `schedule` block arms one row; changing the cron rewrites it; removing the block disarms it; a bad cron fails that file with the message on the source row and leaves the definition unmirrored; an event filter naming an undeclared field fails the same way. Run `pnpm --filter @valet/api test workflow-collector`.

**7. Template mirroring and the owner-scoped catalog.** Add the `workflow_templates` table to `packages/api/src/schema/index.ts` and `packages/api/migrations/pg/0000_app.sql`. Create `packages/api/src/services/content-sync/template-collector.ts` for `.valet/templates/**`, refusing an id that a code catalog template already claims. Modify `packages/api/src/workflows/templates.ts` to add `listCatalogTemplatesForOwner(deps, owner)` beside the pure `listCatalogTemplates`, and `packages/api/src/routes/templates.ts:44` and `:54` to read and install through it.
Test: extend `packages/api/src/workflows/template-catalog.test.ts` — a mirrored template appears after every code template; an id collision is refused at sync with both names in the warning; a team member sees their team's mirrored templates and not another team's. Extend `packages/api/src/workflows/templates.test.ts` so installing a mirrored template produces a `local` workflow. Run `pnpm --filter @valet/api test template-catalog templates`.

**8. Source routes, the admin gate, and push resync.** Move the source handlers from `packages/api/src/routes/skills.ts:569-670` into a new `packages/api/src/routes/repo-sources.ts` mounted at `/api/repo-sources`, accepting `kinds` on create and applying the `canAdministerTeam` gate from decision 10. Keep three delegating handlers at the old paths in `routes/skills.ts`, marked deprecated, so the shipped skills page keeps working until task 10. Modify `packages/api/src/routes/github-app.ts:733` to call `providers.contentSync.onPush(...)` before `ingestEvent`, and add `onPush` to `ContentSyncService`.
Test: extend the renamed `packages/api/src/services/content-sources.test.ts` so a plain team member cannot create a source whose `kinds` include `workflows` and can still create a skills-only one. Create `packages/api/src/routes/github-app.push-resync.test.ts` — a verified push on the tracked ref marks the matching source due without syncing inline; a push on another branch marks nothing; a push for an untracked repository marks nothing. Run `pnpm --filter @valet/api test content-sources github-app`.

**9. Workflow file export.** Modify `packages/api/src/routes/workflows.ts` to add `GET /:id/file` returning the decision-4 envelope, with `format=yaml` as the default and `format=json` accepted, and `Content-Disposition` naming `<slug>.yaml`. Modify `packages/web/src/components/workflows/editor` to add a Download control that calls it.
Test: create `packages/api/src/routes/workflows.file.test.ts` — the exported YAML parses back through `parseWorkflowFileValue` into the same definition, an unowned workflow 404s, and a mirrored workflow exports with its upstream reference recorded in the envelope's `description` and nowhere else. Run `pnpm --filter @valet/api test workflows.file`.

**10. Web: repository sources, origin badges, and run paging.** Rename `packages/web/src/components/skills/skill-sources-panel.tsx` to `repo-sources-panel.tsx` and add the kind checkboxes, disabled with an explanation for a caller who is not a team admin; update `packages/web/src/routes/skills.index.tsx` and `packages/web/src/routes/settings.organization.library.tsx` to the new route. Modify `packages/web/src/routes/workflows.index.tsx` to add the repository badge and a paging control driven by the cursor `GET /api/workflows/runs` already returns. Modify the editor to render a mirrored definition read-only with a link to its file. Land this after PR #389 merges, and do not reimplement its latest-run line.
Test: extend `packages/web/src/components/skills/-skill-sources-panel.test.tsx` (renamed) for the kind checkboxes and the disabled state, and `packages/web/src/routes/-workflows.index.test.tsx` for the badge and the paging control. Run `pnpm --filter @valet/web test repo-sources-panel workflows.index`.

**11. Trigger payload validation against `dataSchema`.** Modify `packages/api/src/workflows/scheduler.ts:164-167`, `packages/api/src/events/dispatcher.ts:246-249`, and `packages/api/src/routes/workflow-hooks.ts:78-81` to run the trigger input through the same `resolveTriggerInput` path the manual run uses, and to record a failed run with a readable message when it does not fit, rather than starting a run that fails inside a node.
Test: extend `packages/api/src/workflows/scheduler.test.ts`, `packages/api/src/events/dispatcher.test.ts`, and `packages/api/src/workflows/webhook-service.test.ts` — a payload missing a required field records a failed run naming the field; a valid payload is unchanged. Run `pnpm --filter @valet/api test scheduler dispatcher webhook-service`.

**12. Documentation.** Rewrite `docs/specs/workflows.md` for dag/v1: the twelve node types (`packages/workflow/src/dag/nodes.ts:224-238`), the four trigger paths, the run lifecycle, and the repository file format from decision 4 with a complete worked example. Delete every reference to the legacy executor. Update `docs/specs/2026-08-05-agent-skills-design.md` where it names `skill_sources`, and add a Deviations note to `docs/specs/2026-08-15-workflow-triggers-ui-design.md` recording that a template can now arm an event trigger.
Test: `make e2e E2E_ARGS="--only docs-lint"`.

**13. Full sweep.** `pnpm typecheck`, then `make e2e` with a clean scorecard captured in full.

## Testing

Unit and integration coverage is named per task above. Three properties need assertions that cut across tasks, and they belong in `packages/api/src/services/content-sync/workflow-collector.test.ts`.

The first is that a failure never deletes. Drive a sync to success, then fail the transport on one file read, and assert that no `workflow_definitions` row moved and that `last_sha` was not recorded. Then restore the transport and assert the next sync converges. This is the rule at `skill-sync.ts:78-88`, restated for a content kind whose deletion also removes armed triggers, which makes a wrong delete more expensive than it is for a skill.

The second is that one sync is one commit. Assert that every file read in a pass carries the commit the head compare resolved, by moving the fixture's default branch between the head read and the file reads and asserting the sync still reads the old commit. A workflow file that references a sibling by name would otherwise mirror two files from two commits.

The third is the credential rule, which is inherited rather than rewritten and therefore easy to break by accident. Extend `packages/api/src/services/content-source-credential.test.ts` so a team source whose creator has left the team drops to an anonymous read, and assert that a workflow-collecting source never reaches the org App installation token unless its owner type is `org`.

## Exit criteria (dogfood)

The platform engineer performs this sequence against a manually rolled deployment, because no continuous deployment exists and `docs/kubernetes.md:241` says remote-cluster deploy automation is not built.

1. Apply the schema edits, run `rm -rf ~/.valet/pg` on the development stack, and start it with `make dev-local`.
2. In the product, build a workflow with the editor: a trigger, an `llm` node, and a `session` node that writes a file into the working directory. Run it once by hand and confirm it succeeds.
3. Download it with the new Download control, commit the file to `.valet/workflows/` in a repository the team can push to, and push.
4. Add that repository as a team source with `kinds` including `workflows`, as a team admin. Confirm the source syncs within one poll and that the mirrored workflow appears in the workflows list with the repository badge naming `owner/repo:.valet/workflows/<file>.yaml`.
5. Confirm the editor refuses to save the mirrored workflow and names the file to edit instead. Confirm `POST /api/workflows/:id/copy` produces a local copy that does save.
6. Run the mirrored workflow by hand and confirm it succeeds, including the `session` node's file write. This is the check that the Tier-0 change in #394 provisions a sandbox lazily for a repository-authored graph.
7. Edit the file in the repository, changing the `llm` prompt, and push. Confirm the mirrored definition updates within one poll of the push, and that the version list shows a new version carrying the pushed commit.
8. Add a `schedule` block to the file and push. Confirm the schedule appears in the Triggers list, and — until the team-credentials spec lands — confirm the source's warning names why a team-owned scheduled workflow with tool nodes stays unarmed.
9. Commit a template file to `.valet/templates/` and push. Confirm it appears in the gallery below the shipped templates, and that installing it produces a local workflow that the installer can edit.
10. Delete the workflow file and push. Confirm the mirrored workflow, its versions, and its schedule are gone within one poll. Repeat with a run in flight and confirm the workflow is disarmed rather than deleted, and that it is deleted on the sync after the run settles.
11. Open the workflows list and confirm the latest run result, the repository badge, and the run paging control all render together.

## Deviations from this design (recorded at implementation)

Tasks 1, 2, and 3 have shipped. Tasks 4 through 13 have not, so the repository sync mirrors no workflow yet: the rail is generalized, `.valet` is open to discovery, and the file envelope has one parser, which is the ground the workflow collector stands on.

1. **The sync service is `ContentSyncService`, not `RepoContentSyncService`.** Decision 1 and tasks 1 and 8 first named the class `RepoContentSyncService`, and its options `RepoContentSyncDeps`. What ships in `packages/api/src/services/content-sync/service.ts` is `ContentSyncService` and `ContentSyncServiceDeps`. This repository names an exported class for the path it sits at — `events/dispatcher.ts` exports `EventDispatcher`, `workflows/scheduler.ts` exports `WorkflowScheduler` — so a `Repo` prefix on a file that already sits in `content-sync/` says the directory twice. Every place this design named the class carries the shipped name.

2. **`ContentCollector` declares `kind` and `discover`; `reconcile` hangs off what `discover` returns.** Decision 2 first described three members, with `reconcile(context)` on the collector itself. What ships is `discover(ctx)` returning a `CollectorPass` — the entries this collector found at this commit, its counts and warnings, and the `reconcile`, `notice`, and `unreadWarning` bound to that pass — plus an optional `walkDirectory` for a commit whose tree GitHub cut. With several collectors in one sweep, a plain `collector.reconcile(manifest)` lets one collector's manifest reach another collector's reconcile; binding the writes to the pass that found them makes that unrepresentable, with no generic parameter and no cast. No rule changed, only the shape of the seam. The same split is why the old private `readManifest` reaches `skill-collector.ts` as `discover` and `walkDirectory` rather than under its old name.

3. **The table rename carries a database that already exists.** Decision 1 says the rename is a text edit in `0000_app.sql` plus `rm -rf ~/.valet/pg`. The migration is edited in place as stated, and `addColumnsMissingFromAppliedMigrations` (`packages/api/src/lib/drizzle.ts`) additionally renames `skill_sources` to `content_sources`, renames its three indexes to match, and adds `kinds` with its default. That function is the repository's standing answer to a pre-1.0 in-place edit and is deleted at 1.0. Without it, every database that is not a developer's own — the test deployment among them — would need a wipe to take a rename, and the indexes would keep their old names. `pg-schema.test.ts` winds a database back to the old table name, drops `kinds`, re-runs the migrations, and asserts the rows, the column default, and the three index names arrive.

4. **The moved sync suite gained two cases the task did not ask for.** Task 1 asks for an import-path move, and every case that moved is unaltered. Two blocks are new: a second collector run beside `SkillCollector` on one sweep, which pins that one tree read, one manifest hash over the union, one merged text map, and both notices are what the seam actually delivers; and a source whose `kinds` name no registered collector, which must mirror nothing and must not throw. Until the workflow collector lands in task 5, `deps.collectors` has exactly one caller in production, so without these two the interface is a shape nothing holds to.

## Non-goals

Personal workflow sync. A user-owned source collects skills only, per the 2026-08-24 decision that personal workflows are a stretch goal. Nothing in this design prevents it later: `kinds` already carries the value and the collector already receives the owner type.

Object storage for workflow definitions. Decision 13 settles this: Postgres already persists them, and export plus repository sync covers the recovery case.

Writing back to the repository. The GitHub App holds `contents: "write"` (`routes/github-app.ts:319-328`), so a "save to repository" button is buildable, and it is out of scope. A mirrored workflow is read-only in the product, and the editor's answer is a local copy.

The workflows UI overhaul. Items 12, 19, 20, 21, and 22 of the MVP checklist belong to it.

Team credential execution. `2026-08-24-team-credentials-and-workflow-bootstrap-design.md` owns it. That spec depends on this one for the sync mechanism its seeded team templates will eventually be delivered by, and this spec depends on it for team-owned scheduled runs. The two land in either order; the gate in decision 9 is what makes that true.

RBAC vocabulary. Decision 10 uses the direct `isTeamMember` and `canAdministerTeam` checks, matching every other 2026-08-24 spec.

## Open questions

**Does a repository file get to pin the workflow's owner, overriding the source's scope?** A repository serving several teams would want `owner: team:platform` in the envelope. Recommended default: no. The owner comes from the source row, and a repository that serves two teams is added twice with two subpaths, which the unique index `(org_id, owner_type, owner_id, repo_full_name, subpath)` already allows. Letting a file name its own owner would make a pull request a way to move a workflow between owners, which is exactly the escalation decision 10 is written to prevent.

**Should a mirrored workflow's run history survive a file rename?** Decision 5 says a rename is a delete plus a create, so it does not. Recommended default: keep it that way for 1.0 and revisit if it bites. The alternative is a stable id written in the file, which invites two files claiming one id and needs its own collision rule; git's own rename detection is a similarity heuristic we would be re-implementing over a tree listing.

**How many workflow files may one source hold?** Skills cap at `MAX_SKILL_CANDIDATES = 300` per sync (`skill-discovery.ts:80`), because each candidate costs one file read. Recommended default: one shared cap of 300 across all kinds for a source, refusing the sync with the existing too-many error and naming the count. A repository with more than 300 tracked files should use `subpath` to narrow the scan.

**Does a push from a fork or a non-default branch resync?** Decision 12 matches the source's tracked ref only. Recommended default: keep it. A source that tracks a release branch resyncs on pushes to that branch, and a source tracking the default branch ignores feature branches, which is what stops an unmerged pull request from arming a schedule.

**Should the sync record a per-file audit entry?** Arming a schedule from a repository is a privileged act, and today it would be visible only as a source warning. Recommended default: write one audit row per armed or disarmed trigger, reusing the existing audit field capping, and leave definition writes to the version history. This is small enough to fold into task 6 if the tech lead wants it before the first team source is created.
