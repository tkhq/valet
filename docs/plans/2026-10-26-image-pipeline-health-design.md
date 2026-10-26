# Image pipeline health: contract gate, fallback, and visibility

Date: 2026-10-26 (revised after adversarial review the same day)
Status: design approved in conversation, awaiting written review
Owner: Conner Swann
Repos: tkhq/valet (sections 5 to 9, 11, 12), tkhq/test-agents-infra (section 10)

## 1. Problem

On 2026-10-19 background child sessions on the `tkhq/sdk` repo image began
failing on their first command. Eight users hit it over a week. The error the
user saw was a Kubernetes controller condition:

```
sandbox failed to start: pod failed: Error seen: PVC "workspace-..." is owned by
Sandbox/... (UID 8f3311cf...), not by sandbox "..."
```

That message was the third link in a chain, not the cause.

1. The repo bake for `tkhq/sdk` (`pb_b8ff0789`, built 2026-09-04) predates
   tini in the sandbox base image (added 2026-09-18). Since 2026-09-25 the
   browser-enabled headless pod command hardcodes `/usr/bin/tini`
   (`packages/sandbox-kubernetes/src/manifest.ts:519`). The container exited
   with `valet-home-start: exec: /usr/bin/tini: not found`.
2. `KubernetesSandboxProvider.create()` classified the crash loop as a
   terminal `SandboxStartupError` and deleted the Sandbox CR it had created.
   `SandboxAttachment.kickProvision()` has no backoff after a terminal error,
   so the next `ensureReady()` recreated the CR under the same name about one
   second later, while the old pod and PVC were still terminating. The
   agent-sandbox controller rejected the new CR because the pod and PVC
   carried the old owner UID. That is the message the user saw.
3. The prebuild scheduler never replaced the stale bake. Its recipe resolver
   reads `pnpm-lock.yaml` through the GitHub contents API, which returns
   `encoding: "none"` and empty content for files over 1 MB. The `tkhq/sdk`
   lockfile is 1.98 MB. `runSchedulerPass` logged `source ... failed` on every
   pass for at least the two days Loki retains at that volume, and the source
   had not pushed a bake since 2026-09-04. Nothing persisted that state, no
   metric counted it, and no one was told.

Two further facts from the review widen the blast radius beyond one repo:

- Base bake image refs are tagged by identity hash, so a base rebake with the
  same identity overwrites the tag. Between 2026-09-18 and 2026-10-26 the base
  source had a new identity and no pushed bake, so every repo bake deferred
  (`RepoBaseLayerBakingError`), and no repo bake could push in that window.
  Every repo bake in the cluster was therefore built from a tini-less base
  until the cascade on 2026-10-26 after 15:20 UTC. Only `tkhq/sdk` surfaced
  because only its children ran the headless-plus-browser command in Loki's
  window.
- No bake row records which base build it was built from, so lineage cannot be
  reconstructed from the database today.

The common thread: Valet hands a session an image without checking that the
image satisfies the runtime contract the pod spec is about to impose on it,
and when the result fails, the failure goes to the agent instead of to an
operator.

## 2. Goals

- A session whose repo image is unusable still starts and does its work. The
  agent never receives an infrastructure failure it cannot act on.
- An admin learns that an image source is broken within minutes, in the app
  and in Slack, without reading logs.
- A repo owner can see why an image is broken and what to do about it.
- The delete-and-recreate race cannot recur, regardless of the underlying
  startup failure.

## 3. Non-goals

- Running repo setup commands live on a fallback session (decided: skip them;
  the existing prep path already skips them when no repo bake resolves,
  `packages/api/src/engine/prep-steps.ts:86-101`).
- Holding a session until a rebake lands (decided: fall back and proceed).
- A per-source opt-out from the fallback.
- Repo-owner notifications. Admin notifications plus the sources page and the
  session banner are the first version.
- A bake log viewer beyond the existing log tail.
- Per-source metric labels. Cardinality stays bounded as in
  `packages/api/src/observability/prebuild-lifecycle.ts`.
- Changing `imagePullPolicy`. Pulling gigabyte images on every start is not
  worth it; section 6.3 makes tags change instead.

## 4. Decisions

| # | Decision | Chosen | Rejected |
|---|---|---|---|
| D1 | Unusable repo image at session start | Fall back to the org base bake if compatible, else the stock image, and proceed | Hold until rebake; per-source opt-out |
| D2 | Setup commands on a fallback session | Skip, and tell the agent | Run before start; run in background |
| D3 | How compatibility is known before a pod exists | An OCI label on the image, read from the local registry after push and stored on the bake row; checked from the DB at session start | Code constant guessed at bake time (wrong for override images and for a stock pin that lags the API); lineage check against the current base bake (noisy); pod probe at session start (slow) |
| D4 | Where source health lives | Persisted on `image_sources`, written by the scheduler | Computed on read |
| D5 | Which alerts page | Only bound-source unusable and scheduler stalled reach Slack | Alerting on every failed bake |
| D6 | Admin audience | Org admins, `org_members.role = admin`, the signal `attention.ts` already uses for `owner.type = "org"` | Instance `user.role`; every org member |
| D7 | Override-image bakes (`.valet/prebuild.yaml` `image:`) | Exempt from the gate; the repo owns compatibility, and the label is read if present | Treat as incompatible (would degrade such repos forever) |

## 5. Image runtime contract

### 5.1 Definition

`SANDBOX_IMAGE_CONTRACT` is an integer constant exported from
`packages/sandbox-kubernetes/src/manifest.ts`. It names the set of things the
pod spec assumes exist inside a sandbox image. The initial value is 3 and
corresponds to the image built from `docker/Dockerfile.sandbox-k8s` today:
`/usr/bin/tini`, `/start-headless.sh`, `/start-full.sh`,
`/usr/local/bin/valet-browser-client`, and `HOME_LAYOUT_VERSION` 2.

`MIN_IMAGE_CONTRACT`, same module, is the lowest contract the current pod spec
can run. It also starts at 3.

Rule for maintainers, as a comment beside the constants: a pull request that
makes `manifest.ts` or the start scripts depend on something new in the image
bumps `SANDBOX_IMAGE_CONTRACT` and the Dockerfile label together. If old
images cannot run the new pod spec at all, it also bumps `MIN_IMAGE_CONTRACT`.

### 5.2 Stamping: the label is authoritative

- `docker/Dockerfile.sandbox-k8s` adds `LABEL io.valet.sandbox.contract="3"`.
  Docker labels are inherited through `FROM`, so every base bake and repo
  bake built on the stock image carries the label without builder changes.
- After a bake transitions to `pushed`, `SourceService.syncActiveBuilds`
  reads the image config from the local registry (manifest, then config
  blob, using the registry client already behind `registry-health.ts`) and
  stores:
  - `bakes.contract_version` (integer, nullable): the label value, or null
    when the label is absent;
  - `bakes.contract_source` (text): `label`, `missing`, or `override`.
  A registry read failure leaves both null and marks the source `stale`
  with reason `contract_unknown`; the next scheduler pass retries the read.
- `bakes.parent_bake_id` (text, nullable) and `bakes.base_image_ref` (text)
  are recorded in `startBaseBake` and `startRepoBake` from the
  `resolveParentBase` result, so lineage is reconstructible from now on.
- Override bakes (`recipe.image` set) get `contract_source = override` and
  whatever the label read returns.

### 5.3 Check

```
compatible(bake) =
  bake.contract_source === "override"
  || (bake.contract_version !== null && bake.contract_version >= MIN_IMAGE_CONTRACT)
```

A missing bake row, a null contract on a non-override bake, or a value below
the minimum reads as incompatible. The check applies only when the sandbox
provider backend is `kubernetes`; docker and local providers skip it.

### 5.4 Backfill

Existing rows have no label (the label ships with this change) and no
lineage. A one-shot repair, run from `SCHEMA_REPAIRS` after the columns exist,
assigns:

- base bakes: 3 if `created_at` is on or after the first stock image that
  contains tini (2026-09-18T20:31Z, commit `56edb1bd9`), else 0;
- repo bakes: the contract of the newest pushed base bake of the parent source
  with `created_at` at or before the repo bake's `created_at`, else 0;
- `contract_source = missing` for all of them.

In agents-dev this yields 0 for everything built before 2026-10-26 15:20:16
UTC and 3 after, which matches what is actually in those images.

## 6. Source health

### 6.1 Columns on `image_sources`

| column | type | values |
|---|---|---|
| `health` | text | `healthy`, `stale`, `incompatible`, `failing`, `unbaked` |
| `health_reason` | text | `ok`, `resolve_failed`, `repo_unreachable`, `credentials`, `registry_full`, `bake_failed`, `contract`, `contract_unknown`, `waiting_for_base` |
| `health_detail` | text, nullable | error text, truncated to 2000 chars |
| `health_checked_at` | bigint ms, nullable | when the scheduler last evaluated the source |

`disabled` is not stored; the UI derives it from `enabled` and `schedule`.
Defaults for existing rows: `healthy`, `ok`, null, null. The first pass after
deploy overwrites them.

| health | meaning |
|---|---|
| `healthy` | current pushed bake is compatible and matches head and recipe |
| `stale` | a compatible bake exists, a newer one is needed, and it has not pushed yet |
| `incompatible` | current bake is below `MIN_IMAGE_CONTRACT`; sessions fall back |
| `failing` | the scheduler cannot evaluate or start a bake for this source |
| `unbaked` | no pushed bake yet (first bake pending or never succeeded) |

### 6.2 Who writes it

`SourceService.setSourceHealth(sourceId, health, reason, detail)` updates the
four columns, refreshes the sources metric snapshot, and routes an admin
notification on a transition (section 11). Call sites:

- `maybeScheduleBase` and `maybeScheduleRepo`, every exit path. Decision to
  health: `hit` is `healthy`; `parent_changed`, `commit_changed`,
  `recipe_changed`, `contract_changed`, `coalesced` are `stale` when a
  compatible bake exists and `unbaked` or `incompatible` otherwise; `defer` is
  `stale` with `waiting_for_base`; `miss` is `unbaked`.
- The `catch` in `runSchedulerPass`, which today only logs. It writes
  `failing` with a reason from the error class: `GitHubApiError` 404 on the
  repo path is `repo_unreachable`; `GitHubApiError` on a file path is
  `resolve_failed`; `AnonymousImageBakesDisabledError` is `credentials`;
  `RegistryCapacityError` is `registry_full`; anything else is `bake_failed`.
- `syncActiveBuilds`, on `pushed`: `healthy` after the label read, or `stale`
  with `contract_unknown` if the read failed. On `failed`: `stale` with
  `bake_failed` if a compatible bake still exists, else `failing`.
- The session resolver (section 7.1), on a fallback: `incompatible` with
  `contract`.

Base sources are first-class here: a base source stuck `failing` is what kept
every repo deferring for four weeks.

### 6.3 Scheduler changes

- Compatibility joins the skip rule in `maybeScheduleRepo`:
  `current && current.commitSha === head.sha && current.identityHash === identity && compatible(current)`;
  the recorded decision for the new case is `contract_changed`. Same for
  `maybeScheduleBase` without the sha term.
- The parent's contract joins the repo identity hash input
  (`identityHash(source, parentIdent, snapshot, parentContract)`), so a
  contract change produces a new identity and a new tag. Without this, a
  `contract_changed` rebake pushes to the same tag and nodes with
  `IfNotPresent` keep serving the cached old layer.
- `readGithubFile` in `packages/api/src/bakes/source-service.ts` (the reader
  `resolveRecipeFromGitHub` uses; `fetchRepoFile` is a different wrapper)
  falls back to `GET /repos/{owner}/{repo}/git/blobs/{sha}` when the contents
  response has `encoding: "none"`, using the `sha` from that response. The
  blob body goes through the same canonical-base64 validation. Any other
  non-base64 contents response still throws.
- `runSchedulerPass` records its completion time in process memory, refreshed
  the same way `refreshObservabilitySnapshot` is. The scheduler and the metric
  exporter share the single valet-api pod; the alert's `for` tolerates a
  restart. No table.

### 6.4 Wire

`SourceSummary` gains `health`, `healthReason`, `healthDetail`,
`healthCheckedAt`. `BakeSummary` gains `contractVersion`, `contractSource`,
`parentBakeId`.

## 7. Session start and fallback

### 7.1 Where the gate lives

Image selection is not in `host.ts`. It is `resolvePrebuildImage`
(`packages/api/src/prebuilds/resolve.ts`), which picks the newest pushed bake
of the repo source, feeding `computeSpec`
(`packages/api/src/engine/sandbox-spec.ts:102`,
`repoBake?.imageRef ?? baseBakeRef ?? stockImage`). `resolveSnapshot`
(`packages/api/src/engine/resolve-snapshot.ts`) already resolves the org base
bake with a kubernetes pull preflight in `resolveBaseImage`. All three
sandboxed session kinds (interactive, child, workflow step) reach this through
`buildSpecProvider`. Two changes:

1. `resolvePrebuildImage` returns null when `!compatible(bake)` and invokes
   an injected `onIncompatible({ sourceId, bakeId, contract })` callback.
   The callback records `agent_sessions.image_fallback` (jsonb:
   `{ reason: "contract", sourceId, bakeId, at }`), calls
   `setSourceHealth(sourceId, "incompatible", "contract", detail)`, increments
   `valet.sandbox.image_fallback`, and requests a bake through the same guard
   sequence `ensureRepoSource` uses (`hasActiveBake`, `repoBakeDefers`, then
   `startBake(source, "binding")`), swallowing `RepoBaseLayerBakingError` and
   `RegistryCapacityError`. `startBake` itself is not idempotent; the guards
   are what prevent a bake per session start.
2. `resolveBaseImage` applies the same `compatible()` test to the org base
   bake and returns null when it fails, so the spec degrades to `stockImage`.
   The stock image is pinned with the API and is compatible by construction.

With a null repo bake the existing prep path skips setup commands, which is
D2 for free. A repo parented at a synthetic `repo-base:<name>` source falls
back to the org base, not that synthetic parent; that is acceptable and now
stated.

### 7.2 What the agent sees

The contract check is cheap (one DB read), so each of the three build paths
runs it eagerly and, on fallback, appends a `## Startup warning` paragraph to
the system prompt using the existing `scratchWarningPrompt` shape:

> Prebuilt dependencies for `<repoFullName>` are unavailable right now because
> the repo image is being rebuilt. The workspace is checked out; install what
> you need.

The paragraph is present on every turn while `image_fallback` is set, not
only the first. There is no first-turn-only seam in the engine, and a note
that disappears mid-task is worse than one that repeats.

### 7.3 When the rebake pushes

Nothing special. `doReconcile` calls the spec provider on every sweep and
`replacementNeeded` replaces the pod when the desired image differs from the
applied one, deferring while a lease is active. So the fallback session moves
to the real image at the next safe window, the same way any bake update rolls
today. The spec provider closure clears `agent_sessions.image_fallback` when
it resolves a compatible repo bake, which removes the banner and the startup
warning.

### 7.4 What the user sees

- Session banner: "Running on the stock image. The `<repo>` image failed its
  compatibility check and is being rebuilt." followed by the guidance line
  for the reason, rendered inline. A "Manage images" link appears only when
  the caller is an org admin and points at
  `/settings/organization/sandbox-images?source=<id>`.
- Sandbox info panel shows the image reference in use: "Image: `<repo>`,
  built 2h ago" or "Image: stock (`<repo>` unavailable)".

## 8. Provisioning hardening

1. **Backoff with fast-fail preserved.** After `doProvisionInner` fails with
   `SandboxStartupError` or `SandboxPreparationError`, the attachment records
   `terminalFailure = { at, attempts, error }`. `kickProvision` does not start
   a provision while `now - at < min(120s, 15s * 2^(attempts-1))`. Inside that
   window `ensureReady` rejects immediately with a `SandboxStartupError`
   carrying the memoized cause and the remaining wait, so a tool call fails
   fast with the real reason instead of waiting out `timeoutMs`. `replace()`
   and `destroy()` clear the memo; `replace()` clears it before its
   `kickProvision`.
2. **Failed-create cleanup waits for removal.** After `destroy(name)` in
   `create()`'s failed-create catch, poll until the pod and the
   `workspace-<name>` PVC are gone, bounded at 30 seconds. The pod check uses
   `livenessApi.getPodUid`; the PVC check needs a `getPvc` on the provider
   deps (the only PVC reader today is in `workspace-pvc.ts` on a separate
   client). A timeout logs and returns.
3. **Pre-create orphan wait.** Before `createNamespacedCustomObject` in
   `applySandbox`, if a pod or PVC with the target name exists whose Sandbox
   owner UID does not match a live CR, wait for it to disappear, bounded at
   30 seconds. This covers the same race from any origin, including two API
   replicas or a restart mid-cleanup, not only the backoff path.
4. **Ownership condition is retry-shaped.** `classifyPodFailure` in
   `lifecycle.ts` returns null for a detail matching `is owned by Sandbox/`,
   which falls through to `provisioning`. `waitReady` keeps polling to its
   60 second deadline and on expiry throws a plain `Error` (not a
   `SandboxStartupError`), so the CR is kept, no second cleanup race occurs,
   and the next create adopts it. `waitReady` gains a `lastDetail` alongside
   `lastState` so the timeout message carries the condition text.
5. **Crash-loop detail.** On `CrashLoopBackOff` the provider reads the sandbox
   container's `lastState.terminated` reason and message and the last line
   of its previous log (best effort, 2 second timeout) and appends them:
   `container crash-looping (CrashLoopBackOff): exit 127: valet-home-start: exec: /usr/bin/tini: not found`.
6. **Guarded tini in the browser command.** `manifest.ts:519` uses the same
   `[ -x /usr/bin/tini ] && exec /usr/bin/tini -g -- ... || exec ...` form the
   docker path at line 586 already uses. Defense in depth behind the gate.
7. **Startup failure counter.** `SandboxStartupError` gains a bounded
   `reason` field set by the provider (`crash_loop`, `image_pull`,
   `unschedulable`, `pod_failed`, `ownership`, `other`); the attachment's
   `recordStartFailure` increments `valet.sandbox.startup_failed` in
   `packages/engine/src/metrics.ts`. `sandbox-kubernetes` has no meter and
   stays that way. `ownership` is counted when `waitReady` times out with the
   ownership detail as `lastDetail`.
8. **Workflow image pin.** Pre-existing mismatch, fixed here because the
   stock fallback exposes it: workflow sessions create with
   `this.opts.defaultImage` (`host.ts:4626`) while `buildSpecProvider`
   compares against `defaultImages.full ?? defaultImage`. Both use the latter.

What still terminates a session: an unschedulable pod after the capacity
wait, an image pull failure, or a crash loop on the stock image itself. Those
are platform conditions covered by section 10, and the message shown follows
"The sandbox could not start: `<reason>`. `<one action>`".

## 9. Metrics

Added to `prebuild-lifecycle.ts` and `packages/engine/src/metrics.ts`, using
`boundedPrebuildAttributes` plus the bounded enums below. No source names or
ids as labels.

| metric | type | labels | meaning |
|---|---|---|---|
| `valet.prebuild.sources` | observable gauge | source_kind, health, reason | count of sources by health |
| `valet.prebuild.sources.bound_unhealthy` | observable gauge | source_kind | sources whose health is `incompatible`, `failing`, or `unbaked` and that matter: a repo source bound by a session in the last 7 days, or a base source with any such repo beneath it |
| `valet.prebuild.scheduler.last_pass_age` | observable gauge, unit `s` | none | age of the last completed scheduler pass |
| `valet.sandbox.image_fallback` | counter | reason | sessions that fell back to a base or stock image |
| `valet.sandbox.startup_failed` | counter | reason | terminal startup failures |

Prometheus names follow the existing OTLP mapping seen in the dashboard:
`valet_prebuild_sources`, `valet_prebuild_sources_bound_unhealthy`,
`valet_prebuild_scheduler_last_pass_age_seconds`,
`valet_sandbox_image_fallback_total`, `valet_sandbox_startup_failed_total`.
The gauges are observed from a snapshot refreshed on every scheduler pass and
every `setSourceHealth` call. The dashboard gets an "Images" row.

## 10. Alerts (tkhq/test-agents-infra)

New file `modules/platform/image-pipeline-alerts.tf`, same shape as
`critical-alerts.tf`. `severity=critical` routes to `slack-critical` per
`monitoring.tf`; `warning` stays UI-only.

| alert | expr | for | severity |
|---|---|---|---|
| `ValetImageSourceUnusable` | `sum(valet_prebuild_sources_bound_unhealthy) > 0` | 30m | critical |
| `ValetBakeSchedulerStalled` | `valet_prebuild_scheduler_last_pass_age_seconds > 1800` | 10m | critical |
| `ValetSandboxStartupFailures` | `sum(increase(valet_sandbox_startup_failed_total[15m])) > 3` | 5m | warning |
| `ValetImageFallbacks` | `sum(increase(valet_sandbox_image_fallback_total[1h])) > 0` | 0m | warning |

`ValetImageSourceUnusable` is bound-scoped on purpose: dormant test repos
with broken bakes must not page.

Rule testing: the infra repo has no `promtool` today. Add a CI step that runs
`promtool test rules` against a `tests/` file with one synthetic series per
alert. This is new tooling, not an addition to `validate-flux-render.sh`.

Runbook addition in `docs/runbooks/agents-dev-flux-operations.md`: for each
alert, the page to open and the reason-to-action table from 11.2.

## 11. Admin notifications and UI

### 11.1 Notifications

- New `AttentionKind` and `NotificationKind` value `platform`, added in
  `packages/api/src/wire/types.ts`, `packages/api/src/routes/notifications.ts`
  (`NOTIFICATION_KINDS`), and
  `packages/web/src/routes/settings.notifications.tsx`. `notifications.kind`
  is free text, so no DDL. The preferences page shows the kind only to org
  admins.
- `setSourceHealth` calls `routeAttention` on a transition into or out of
  `incompatible`, `failing`, or `unbaked`, with
  `owner: { type: "org", id: source.orgId }`, which `attentionAudience`
  already resolves to `org_members.role = admin`. No producer uses an org
  owner today, so this path gets its own tests.
- Dedupe: `dedupeKey = image-source:<sourceId>:<reason>:<enteredAt>` where
  `enteredAt` is the `health_checked_at` at which the source entered the
  non-healthy state. A fresh failure after a recovery therefore produces a
  fresh notification; repeated passes inside one episode do not.
- Channel delivery: the DM gate in `routeAttention` is widened from
  `owner.type === "team"` to `owner.type !== "user"`, so org-owned events are
  web-only unless the admin's `teamDm` preference for `platform` is on.
- Fields: `urgency` `high` for `incompatible` and `failing`, `normal` for
  `unbaked` and recovery; title "Image for `<name>` cannot be rebuilt" or
  "Image for `<name>` is unusable; sessions are using the stock image"; body
  is the guidance line plus `healthDetail`; href
  `/settings/organization/sandbox-images?source=<sourceId>`.
- Recovery: on return to `healthy`, `markAttentionNotificationsRead` is called
  with the episode's full key, and one `normal` notification "Image for
  `<name>` is healthy again" is posted. To avoid flapping noise, the recovery
  notification is only posted if the episode lasted over 10 minutes or caused
  at least one fallback.
- Immediate triggers, not waiting for the next pass: a session fallback and a
  bake transition to `failed` on a bound source.

### 11.2 Reason to guidance

One table in `packages/web/src/components/settings/source-health.ts`, shared
by the sources row, the session banner, the notification body, and the
runbook.

| reason | guidance |
|---|---|
| `resolve_failed` | Valet could not read the repo's recipe or lockfile. Usually a platform bug; the detail names the file. |
| `repo_unreachable` | The Valet GitHub app lost access. Reinstall it on this repository. |
| `credentials` | Anonymous bakes are off for this org. Connect an org GitHub credential. |
| `registry_full` | The image registry is out of space. Retention needs to run. |
| `bake_failed` | The setup commands failed. The log tail shows where. |
| `contract` | The image was built before a runtime change. A rebuild is already queued. |
| `contract_unknown` | Valet could not read the image's label from the registry. It will retry. |
| `waiting_for_base` | The base image is building first. Nothing to do. |
| `ok` | (no guidance rendered) |

### 11.3 Sources page

`/settings/organization/sandbox-images`, admin-only via `OrganizationLayout`.
In `packages/web/src/components/settings/sources-section.tsx`:

- Each row shows a `StatusDot` by health and a phrase: "Healthy, built 2h
  ago", "Rebuilding", "Unusable: image predates the current runtime",
  "Failing: `<guidance>`", "Not built yet". Status sort orders `failing`,
  `incompatible`, `unbaked`, `stale`, `healthy`, then disabled.
- Expanded row: current bake, commit built from, contract version and source,
  parent bake, `healthCheckedAt`, `healthDetail`, log tail, "Bake now"
  (exists), "Open bake history".
- Query param `?source=<id>` expands that row on load.

### 11.4 Session

Fallback banner and image label per 7.4. Terminal startup errors render the
classified message from section 8, never a raw controller condition.
"Replace sandbox" remains available and clears the backoff memo.

## 12. Schema changes

Shipped as `SCHEMA_REPAIRS` entries in `packages/api/src/lib/drizzle.ts` with
catalog probes, plus the matching `0000_app.sql` and `drizzle-kit generate`
output, so fresh databases and existing ones converge at API boot. Manual
ALTERs on CNPG are not the mechanism; the agents-dev deploy only needs the
usual "schema-affecting deploy" caution (remediation rollback off).

```sql
ALTER TABLE bakes
  ADD COLUMN IF NOT EXISTS contract_version integer,
  ADD COLUMN IF NOT EXISTS contract_source text,
  ADD COLUMN IF NOT EXISTS parent_bake_id text,
  ADD COLUMN IF NOT EXISTS base_image_ref text;

ALTER TABLE image_sources
  ADD COLUMN IF NOT EXISTS health text NOT NULL DEFAULT 'healthy',
  ADD COLUMN IF NOT EXISTS health_reason text NOT NULL DEFAULT 'ok',
  ADD COLUMN IF NOT EXISTS health_detail text,
  ADD COLUMN IF NOT EXISTS health_checked_at bigint;

ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS image_fallback jsonb;
```

The contract backfill (5.4) is the `backfill` step of the `contract_version`
repair: one SQL statement for base bakes, one correlated UPDATE for repo bakes
joining the parent's newest earlier pushed bake, both ending in `RETURNING`
so the repair records its row count.

## 13. Testing

- Scheduler (`source-service.test.ts`): an incompatible current bake is baked
  despite matching head and identity; the parent contract changes the child
  identity; every `maybeSchedule*` exit writes health, including the thrown
  path; `readGithubFile` falls back to blobs on `encoding: "none"` and still
  rejects a non-base64 body; the post-push label read sets `contract_version`
  and `contract_source`, and a read failure sets `contract_unknown`.
- Resolver (`resolve.test.ts`, `resolve-snapshot` tests): an incompatible or
  missing repo bake yields null and fires the callback once; an incompatible
  base bake yields the stock image; an override bake passes; the callback
  does not start a second bake when one is active; compatible path is
  byte-identical to today.
- Attachment (`attachment.test.ts`): after a terminal startup error, a fake
  provider sees no second `create` inside the window; `ensureReady` inside
  the window rejects immediately with the memoized cause; after the window it
  retries; `replace()` bypasses.
- Provider conformance suite: failed-create cleanup waits for pod and PVC
  removal; pre-create orphan wait; ownership condition reports
  `provisioning` and the timeout message carries the detail; crash-loop error
  includes the termination message; `reason` is set on every
  `SandboxStartupError`.
- Spec provider: fallback clears when a compatible bake resolves; the startup
  warning paragraph is present while `image_fallback` is set.
- Notifications (`attention` tests): org owner resolves to org admins only;
  same episode yields one row per admin; a new episode after recovery yields
  a new row; recovery marks the episode read; no DM job is enqueued for an
  org owner without `teamDm`.
- Web: sources row renders each health and guidance; `?source=` expands;
  banner renders inline guidance and hides the link for non-admins.
- Repairs: a fresh database and a database with the old columns both reach
  the same schema; the backfill produces the expected contracts on a fixture
  with a pre- and post-tini base bake.
- Infra: `promtool test rules` cases for the four alerts.

## 14. Rollout

Four pull requests, each shippable alone.

1. **valet, stop the bleeding.** `readGithubFile` blobs fallback; guarded tini
   at `manifest.ts:519`; `kickProvision` backoff with fast-fail inside the
   window; failed-create wait-for-gone; pre-create orphan wait; ownership
   condition retry-shaped with `lastDetail`; crash-loop detail; `reason` on
   `SandboxStartupError` and the `startup_failed` counter; workflow image pin;
   and the `LABEL io.valet.sandbox.contract="3"` in the Dockerfile so the
   stock image carries it before PR 2 needs it. No schema change.
2. **valet, contract and health.** Schema repairs (section 12) with the
   backfill; `SANDBOX_IMAGE_CONTRACT` and `MIN_IMAGE_CONTRACT`; post-push
   label read; `parent_bake_id` and `base_image_ref` recording;
   `setSourceHealth` and all call sites; `contract_changed` and the identity
   change; gates in `resolvePrebuildImage` and `resolveBaseImage` with the
   callback; `image_fallback` and its clearing; startup warning paragraph;
   `image_fallback` counter; in-process last-pass timestamp.
3. **valet, visibility.** Wire fields; sources page health, guidance, deep
   link; session banner and image label; `platform` kind, org-owner fanout,
   DM gate, dedupe and recovery; sources gauges and scheduler age gauge;
   dashboard row.
4. **test-agents-infra, alerts.** `image-pipeline-alerts.tf`; promtool CI
   step and test file; runbook section; chart guard bump in
   `scripts/validate-flux-render.sh` if the chart version moves.

Expected effect at the PR 2 deploy in agents-dev: every bake built before
2026-10-26 15:20 UTC is stamped 0, the six sources still on such bakes become
`incompatible`, and the scheduler rebakes them. Sessions bound to them fall
back until the rebake pushes. Everything baked in the 2026-10-26 cascade is
stamped 3 and unaffected.

Manual step after PR 1 is live: "Bake now" on `tkhq/sdk`. The base already
contains tini; only the lockfile read was blocking. That unblocks the affected
users before PR 2 lands.

## 15. Risks and open items

- The label read depends on the local registry answering manifest and config
  requests. `registry-health.ts` already talks to it; if a read fails the bake
  stays `contract_unknown` and is retried, and the session gate treats it as
  incompatible, which is the safe side.
- A `MIN_IMAGE_CONTRACT` bump invalidates every bake at once and every bound
  session falls back until the cascade finishes. That is correct behavior and
  `ValetImageFallbacks` makes the window visible. Land bumps with a note in
  the PR and outside working hours where possible.
- Override images that lack the label are exempt by D7 and can still crash on
  a contract change. The guarded tini command and the crash-loop detail keep
  that diagnosable in one line; the guidance for such repos is to `FROM` the
  stock image.
- Open: why the base source made no bake attempt between 2026-09-29 and
  2026-10-26 after five failures. The `failing` health on base sources and
  `ValetImageSourceUnusable` would surface a repeat; the cause should be read
  from Loki during PR 2 and recorded in the runbook.
- Fallback sessions do more live installing, raising registry and network
  load during an outage. Acceptable; it replaces sessions that failed
  outright.

## 16. Evidence

Investigation notes from 2026-10-26, agents-dev. Loki retains valet-api and
sandbox pod logs for about two weeks; the controller and kubelet retain far
less, so Loki is the first stop for any future startup investigation.

| time (UTC) | event | source |
|---|---|---|
| 09-18 20:31 | tini enters `docker/Dockerfile.sandbox-k8s` (`56edb1bd9`) | git |
| 09-18 to 09-29 | five base bake attempts fail; no base push until 10-26 | bakes table |
| 10-19 17:53 | first `tini: not found` on a `tkhq/sdk` child | Loki, valet-sandboxes |
| 10-25 04:45 onward | scheduler fails `tkhq/sdk` every 10 min on `pnpm-lock.yaml` | Loki, valet-api |
| 10-26 15:20 | base bake `pb_ed36f016` pushes; repo cascade follows | bakes table |
| 10-26 17:30:17 | child `1d1495c0` CR created, UID 8f3311cf | controller log |
| 10-26 17:30:41 | container exits, tini missing | Loki, valet-sandboxes |
| 10-26 17:30:44 | `SandboxStartupError: crash-looping`; create() deletes CR | valet-api |
| 10-26 17:30:45 | new CR, same name; controller rejects old-UID pod and PVC | controller log |
| 10-26 17:30:46 | second `SandboxStartupError` with the ownership text | valet-api |
