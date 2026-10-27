# Image pipeline health: contract gate, fallback, and visibility

Date: 2026-10-26 (revised after adversarial review the same day)
Status: design approved; amended 2026-10-27 to match what was built (see 15.1)
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
the minimum reads as incompatible. The check applies only to kubernetes. Two
gates express this: `contractGateApplies(provider)` in
`packages/api/src/prebuilds/resolve.ts` (the sandbox provider backend is
`kubernetes`) guards session start, and `SourceService.contractEnforced` (the
image builder backend is `kubernetes`) guards the scheduler (6.3). Docker and
local providers skip the check. Stamping (5.2) runs on every backend.

### 5.4 Backfill

Existing rows have no label (the label ships with this change) and no
lineage. A one-shot repair, run from `SCHEMA_REPAIRS` after the columns exist,
is the single statement `CONTRACT_BACKFILL_SQL` in
`packages/api/src/lib/drizzle.ts`. It touches only rows with
`contract_version IS NULL`, so it is idempotent. The tini epoch is the first
stock image that contains tini (2026-09-18T20:31:00Z, commit `56edb1bd9`,
`TINI_EPOCH_MS`). It assigns:

- base bakes: 3 if `created_at` is on or after the tini epoch, else 0;
- repo bakes: find the newest pushed bake of the parent base source
  (`parent_id`, kind `base`) with `created_at` at or before the repo bake's
  `created_at`, and apply the same epoch test to that parent bake's
  `created_at`: 3 if on or after the epoch, else 0. A repo bake with no such
  parent bake (no parent, an external parent, or no earlier pushed base bake)
  gets 0;
- `contract_source`: `missing` for base bakes; for repo bakes `override` when
  `recipe->>'image'` is set, else `missing`. Override-image bakes therefore
  stay exempt from the gate (D7) whatever value they receive.

In agents-dev this yields 0 for everything built before 2026-10-26 15:20:16
UTC and 3 after, which matches what is actually in those images.

## 6. Source health

### 6.1 Columns on `image_sources`

| column | type | values |
|---|---|---|
| `health` | text | `healthy`, `stale`, `incompatible`, `failing`, `unbaked` |
| `health_reason` | text | `ok`, `resolve_failed`, `repo_unreachable`, `credentials`, `registry_full`, `bake_failed`, `contract`, `contract_unknown`, `waiting_for_base` |
| `health_detail` | text, nullable | error text, truncated to 2000 chars |
| `health_checked_at` | bigint ms, nullable | when the source entered its current `health` and `health_reason` ("in this state since") |

`disabled` is not stored; the UI derives it from `enabled` and `schedule`.
Defaults for existing rows: `healthy`, `ok`, null, null. The first pass after
deploy overwrites them. `health_checked_at` is not a heartbeat: a pass that
confirms the same state does not write it. Scheduler liveness is the
`last_pass_age` gauge (6.3, 9).

| health | meaning |
|---|---|
| `healthy` | current pushed bake is compatible and matches head and recipe |
| `stale` | a compatible bake exists, a newer one is needed, and it has not pushed yet |
| `incompatible` | current bake is below `MIN_IMAGE_CONTRACT`; sessions fall back |
| `failing` | the scheduler cannot evaluate or start a bake for this source |
| `unbaked` | no pushed bake yet (first bake pending or never succeeded) |

### 6.2 Who writes it

`SourceService.setSourceHealth(sourceId, health, reason, detail)` compares the
new health and reason with the stored ones and returns whether it
transitioned. On a transition (health or reason changed) it writes all four
columns with `health_checked_at = now`, refreshes the sources metric
snapshot, and routes an admin notification (section 11). Without a
transition it writes `health_detail` only when the text changed and leaves
`health_checked_at` alone. Call sites:

- `maybeScheduleBase` and `maybeScheduleRepo`, every exit path. Decision to
  health: `hit` is `healthy`; `defer` is `stale` with `waiting_for_base`. A
  pending bake (`parent_changed`, `commit_changed`, `recipe_changed`,
  `contract_changed`, `coalesced`, `miss`) takes its health from
  `pendingHealth(current, newest)`, where `newest` is the newest bake of any
  status: when `newest` is `failed`, `failing` with `bake_failed` (`stale`
  with `bake_failed` if a compatible pushed bake survives), so one episode
  spans every retry; otherwise `unbaked` with no pushed bake, `incompatible`
  with `contract` when the current bake fails the check, and `stale` with
  `ok` in the remaining cases. A current bake with null contract columns has
  its label re-read first (`rereadContract`); a second failed read is
  `stale` with `contract_unknown`. Health is written after `startBake`
  resolves, so a throw reaches the catch below without passing through a
  pending state.
- The `catch` in `runSchedulerPass`, which today only logs. It writes
  `failing` with a reason from the error class: `GitHubApiError` 404 on the
  repo path is `repo_unreachable`; `GitHubApiError` on a file path is
  `resolve_failed`; `AnonymousImageBakesDisabledError` is `credentials`;
  `RegistryCapacityError` is `registry_full`; anything else is
  `resolve_failed`. `bake_failed` is reserved for a bake that actually
  failed (the `syncActiveBuilds` and `pendingHealth` paths).
- `syncActiveBuilds`, on `pushed`: after the label read, `healthy` when the
  bake is compatible, `incompatible` with `contract` when it is not, or
  `stale` with `contract_unknown` if the read failed. On `failed`: `stale`
  with `bake_failed` if a compatible pushed bake survives, else `failing`
  with `bake_failed`.
- `SourceService.handleImageFallback` (section 7.1), on a session fallback:
  `incompatible` with `contract`, but only out of a state with no diagnosis
  (`healthy`, `unbaked`, or `stale` with `ok`). It never overwrites a
  scheduler diagnosis (`failing`, `incompatible`, or `stale` with a reason).

Base sources are first-class here: a base source stuck `failing` is what kept
every repo deferring for four weeks.

### 6.3 Scheduler changes

- Compatibility joins the skip rule in `maybeScheduleRepo`:
  `current && current.commitSha === head.sha && current.identityHash === identity && contractOk(current)`,
  where `contractOk` is `compatible()` when the contract is enforced and true
  otherwise; the recorded decision for the new case is `contract_changed`.
  Same for `maybeScheduleBase` without the sha term.
- A contract rebake keeps the identity hash (its inputs did not change) and
  pushes to a fresh tag instead: `startBaseBake` and `startRepoBake` append
  `-c<MIN_IMAGE_CONTRACT>` to the image ref when `contractRebakeFor` says
  `rebake`. Deriving this inside the two start functions gives every trigger
  (scheduler, cascade, manual, binding) the suffix. Without a new tag, nodes
  with `IfNotPresent` keep serving the cached old layer.
- `contractRebakeFor(current, identity, sha?)` is the one decision, shared
  by the schedulers, the start functions, and the fallback handler. It
  returns null when the contract is not enforced, there is no current bake,
  its identity (or, for repos, its sha) differs, or it is compatible;
  `reread` when its contract columns are null (re-read the label with
  `rereadContract`, never rebake); `stuck` when its ref already ends in
  `-c<MIN_IMAGE_CONTRACT>` and it is still incompatible (no rebake loop;
  health stays `incompatible` with `contract` and sessions fall back, the
  external-parent-without-label case in section 15); `rebake` otherwise.
- A child, either a repo or a base parented at a base, defers when its
  parent base's current bake fails `contractOk`, the same as for a stale
  parent identity, and records `stale` with `waiting_for_base`. The parent's
  push cascade starts base children as well as repo children.
- All contract terms in the scheduler (`contractOk` in the skip rules,
  `contractRebakeFor`, the parent defer) apply only when the image builder
  backend is `kubernetes` (`contractEnforced`), matching the session gate.
  On the docker backend labels are still stamped, but no source is rebaked
  or deferred for its contract.
- `readGithubFile` in `packages/api/src/bakes/source-service.ts` (the reader
  `resolveRecipeFromGitHub` uses; `fetchRepoFile` is a different wrapper)
  falls back to `GET /repos/{owner}/{repo}/git/blobs/{sha}` when the contents
  response has `encoding: "none"`, using the `sha` from that response. The
  blob body goes through the same canonical-base64 validation. Any other
  non-base64 contents response still throws.
- `runSchedulerPass` records its completion time in process memory
  (`recordSchedulerPass`), and `SourceService.start()` records a seed pass
  when it arms the scheduler interval, so a scheduler stuck from boot still
  ages. The seed pass is recorded only when an image builder exists; a
  process with no builder runs no scheduler and records nothing. The
  scheduler and the metric exporter share the single valet-api pod; the
  alert's `for` tolerates a restart. No table.

### 6.4 Wire

`SourceSummary` gains `health`, `healthReason`, `healthDetail`,
`healthCheckedAt`, and its `latestBake` summary on list responses carries
`finishedAt` beside `status` and `createdAt`. `BakeSummary` gains
`contractVersion`, `contractSource`, `parentBakeId`. Session wire fields are
in 7.4.

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

1. `resolvePrebuildImage` returns null when
   `contractGateApplies(provider) && !compatible(bake)` and invokes an
   injected `onIncompatible({ sourceId, bakeId, contract, repoFullName })`
   callback. A callback failure never changes the resolution. The host's
   callback writes `agent_sessions.image_fallback` (jsonb `ImageFallback`:
   `{ reason: "contract", sourceId, bakeId, at }`) only when it is null or
   names a different bake, increments `valet.sandbox.image_fallback` only
   when that write changed a row, and then calls
   `SourceService.handleImageFallback`. The callback runs on every reconcile
   of a fallen-back session, so the handler is idempotent and keeps the turn
   path DB-only:
   - it is a no-op unless `contractEnforced` (6.3), so the docker backend
     never handles a fallback;
   - it writes `incompatible` with `contract` only out of a state with no
     diagnosis (6.2), so it never overwrites the scheduler's;
   - it acts only when the newest bake of any status is the one the session
     fell back from, so a retry that failed or is active is left to the
     scheduler;
   - it runs at most one piece of work per source (an in-flight map), without
     await;
   - on `reread` from `contractRebakeFor` it calls `rereadContract` and does
     not bake; on `stuck` it does nothing;
   - a `failing` source (the scheduler retries it) or one that is `stale`
     with `waiting_for_base` (the base's push cascade bakes it) gets no bake
     request;
   - otherwise it requests a bake through the guard sequence
     `ensureRepoSource` uses (`repoBakeDefers`, `hasActiveBake`, then
     `startBake(source, "binding")`), logging and swallowing errors.
     `startBake` itself is not idempotent; the guards and the in-flight map
     are what prevent a bake per session start.
2. `resolveBaseImage` applies the same gate
   (`contractGateApplies(provider) && !compatible(bake)`) to the org base
   bake and returns null when it fails, so the spec degrades to `stockImage`.
   The stock image is pinned with the API and is compatible by construction.

With a null repo bake the existing prep path skips setup commands, which is
D2 for free. A repo parented at a synthetic `repo-base:<name>` source falls
back to the org base, not that synthetic parent; that is acceptable and now
stated.

### 7.2 What the agent sees

The contract check is cheap (one DB read, `repoBakeCompatibility`), so each
of the three build paths (interactive, child, workflow step) runs it eagerly
before it builds the session. When the check says the repo bake is
incompatible, `imageFallbackPrompt(repoFullName)` in
`packages/api/src/engine/host.ts` appends a `## Startup warning` section to
the system prompt, the same shape `scratchWarningPrompt` uses:

> Prebuilt dependencies for `<repoFullName>` are unavailable right now because
> the repo image is being rebuilt. The workspace is checked out; install what
> you need.

The paragraph is part of the system prompt of that session build, so it is
present on every turn of the build, not only the first. There is no
first-turn-only seam in the engine, and a note that disappears mid-task is
worse than one that repeats. The eager check at build time decides it, not
`image_fallback`, so the paragraph goes away at the first build after the
rebake pushes.

An interactive session also gets one system entry on the thread that
triggered the build, through `noteSessionWarning`. The entry is written once;
a rebuild that finds the same text does not write it again:

> Running on the stock image: the `<repoFullName>` image failed its
> compatibility check and is being rebuilt. Prebuilt dependencies are
> unavailable until then.

Child and workflow sessions get the prompt paragraph only.

### 7.3 When the rebake pushes

Nothing special. `doReconcile` calls the spec provider on every sweep and
`replacementNeeded` replaces the pod when the desired image differs from the
applied one, deferring while a lease is active. So the fallback session moves
to the real image at the next safe window, the same way any bake update rolls
today. The spec provider closure clears `agent_sessions.image_fallback` when
it resolves a compatible repo bake, which removes the banner. The clear is a
conditional write, so a steady-state session costs no row write per
reconcile. The startup warning follows 7.2.

### 7.4 What the user sees

`SessionDetail.sandboxImage` (`packages/api/src/wire/types.ts`; absent on
list rows) is a `SessionSandboxImage`:
`{ source: "repo" | "stock", repoFullName, builtAt, fallback: ImageFallback | null }`.
`ImageFallback` is the `agent_sessions.image_fallback` shape from 7.1. The
sessions route returns `source: "repo"` with `builtAt = finishedAt ?? createdAt`
when the session's recorded `bake_id` resolves to a bake, and otherwise
`source: "stock"` with `fallback` copied from `image_fallback`.

- Session banner (`ImageFallbackBanner`, shown while `fallback` is set):
  "Running on the stock image. The `<repo>` image failed its compatibility
  check and is being rebuilt." followed by the guidance line for the reason,
  rendered inline. A "Manage images" link appears only when the caller is an
  org admin and points at `/settings/organization/sandbox-images?source=<id>`.
- Sandbox info panel shows the image in use: "Image: `<repo>`, built 2h ago",
  "Image: stock (`<repo>` unavailable)", or "Image: stock" for a session
  with no repo.

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
   `create()`'s failed-create catch, and only when the destroy succeeded,
   `awaitSameNameResourcesGone` polls until the pod and the
   `workspace-<name>` PVC are gone, bounded at 30 seconds
   (`RESOURCE_GONE_TIMEOUT_MS`). The pod check uses `livenessApi.getPodUid`;
   the PVC check uses a `pvcApi.readPvc` on the provider deps and is skipped
   when none is wired. A read error counts as still present. A timeout logs
   and returns.
3. **Pre-create orphan wait.** In `create()`, when this call's GET found no
   Sandbox CR, the same wait runs before `applySandbox`. With no CR there is
   no live owner, so a pod or PVC under the target name belongs to a deleted
   predecessor that is being garbage-collected; when a CR exists, the call
   adopts it instead. Separately, `resolvePodName` in `lifecycle.ts` matches a
   pod's controller `PodOwnerReference.uid` against the CR's UID when the CR
   has one, so a same-name pod owned by a deleted predecessor is never taken
   for the new CR's pod. This covers the race from any origin, including two
   API replicas or a restart mid-cleanup, not only the backoff path.
4. **Ownership condition is retry-shaped.** `classifyPodFailure` in
   `lifecycle.ts` returns null for a `PodFailed` detail matching
   `is owned by Sandbox/` (`OWNERSHIP_CONDITION_PATTERN`), which falls
   through to `provisioning`. `waitReady` keeps polling to its 60 second
   deadline and tracks `lastDetail` (the Ready condition message) alongside
   `lastState`. On expiry with the ownership detail it throws a
   `SandboxStartupError` of kind `ownership` whose message says the
   controller is waiting for the previous sandbox's pod and volume to be
   removed and that this retries automatically. Any other expiry throws a
   plain `Error` that carries the condition text. `create()`'s failed-create
   cleanup never deletes the CR for kind `ownership`, so no second cleanup
   race occurs, the backoff in item 1 spaces the retries, and the next create
   adopts the CR.
5. **Crash-loop detail.** On `CrashLoopBackOff` the provider reads the sandbox
   container's `lastState.terminated` reason and message and the last line
   of its previous log (best effort, 2 second timeout) and appends them:
   `container crash-looping (CrashLoopBackOff): exit 127: valet-home-start: exec: /usr/bin/tini: not found`.
6. **Guarded tini in the browser command.** `manifest.ts:519` uses the same
   `[ -x /usr/bin/tini ] && exec /usr/bin/tini -g -- ... || exec ...` form the
   docker path at line 586 already uses. Defense in depth behind the gate.
7. **Startup failure counter.** `SandboxStartupError` gains a bounded
   `kind` field (`SandboxStartupKind` in `packages/engine/src/errors.ts`:
   `crash_loop`, `image_pull`, `unschedulable`, `pod_failed`, `ownership`,
   `capacity`, `other`; `SANDBOX_STARTUP_KINDS` lists them). The provider
   sets it (`startupKindOf` maps its reason strings), and the API's sandbox
   capacity gate sets `capacity` when an org waits past its sandbox ceiling.
   The attachment's `recordStartFailure` calls
   `recordSandboxStartupFailure(kind)`, which increments
   `valet.sandbox.startup_failed{kind}` in `packages/engine/src/metrics.ts`.
   `sandbox-kubernetes` has no meter and stays that way. `ownership` is
   counted when `waitReady` times out with the ownership detail (item 4).
8. **Workflow image pin.** Pre-existing mismatch, fixed here because the
   stock fallback exposes it: workflow sessions create with
   `this.opts.defaultImage` (`host.ts:4626`) while `buildSpecProvider`
   compares against `defaultImages.full ?? defaultImage`. Both use the latter.

What still terminates a session: an unschedulable pod after the capacity
wait, an image pull failure, or a crash loop on the stock image itself. Those
are platform conditions covered by section 10, and the message shown follows
"The sandbox could not start: `<reason>`. `<one action>`".

## 9. Metrics

Added to `packages/api/src/observability/prebuild-lifecycle.ts` (gauges),
`packages/api/src/observability/image-fallback-metrics.ts`, and
`packages/engine/src/metrics.ts`, using `boundedPrebuildAttributes` plus the
bounded enums below. No source names or ids as labels.

| metric | type | labels | meaning |
|---|---|---|---|
| `valet.prebuild.sources` | observable gauge | source_kind, health, reason | count of sources by health and reason |
| `valet.prebuild.sources.bound_unhealthy` | observable gauge | source_kind | sources whose health is `incompatible`, `failing`, or `unbaked` and that matter: a repo source bound by a session in the last 7 days, or a base source with any such repo beneath it |
| `valet.prebuild.scheduler.last_pass_age` | observable gauge, unit `s` | none | seconds since the last completed scheduler pass, or since the seed pass at scheduler start (6.3); absent in a deployment with no image builder |
| `valet.sandbox.image_fallback` | counter | reason | sessions that fell back from their repo image, counted once per session and bake (7.1) |
| `valet.sandbox.startup_failed` | counter | kind | terminal startup failures (8.7) |

Prometheus names follow the existing OTLP mapping seen in the dashboard:
`valet_prebuild_sources`, `valet_prebuild_sources_bound_unhealthy`,
`valet_prebuild_scheduler_last_pass_age_seconds`,
`valet_sandbox_image_fallback_total`, `valet_sandbox_startup_failed_total`.
The source gauges are observed from a snapshot refreshed on every poll pass
and on every `setSourceHealth` transition. The snapshot replaces rather than
accumulates: an attribute set that left the snapshot observes 0, because the
SDK otherwise keeps a cumulative gauge's last value. Both counters are
zero-initialized for every known label value at api boot
(`initImageFallbackMetrics` and `initSandboxMetrics`, called from
`packages/api/src/main.ts`), so `increase()` sees the first event after a
restart. The dashboards get an "Images" row (section 10).

## 10. Alerts (tkhq/test-agents-infra)

The rules live in `modules/platform/files/image-pipeline/rules.yaml`.
`modules/platform/image-pipeline-alerts.tf` wraps that file in a
`PrometheusRule` (`kubectl_manifest`), so promtool tests the same file the
cluster gets. `severity=critical` routes to `slack-critical` per
`monitoring.tf`; `warning` stays UI-only.

| alert | expr | for | severity |
|---|---|---|---|
| `ValetImageSourceUnusable` | `sum(valet_prebuild_sources_bound_unhealthy) > 0` | 30m | critical |
| `ValetBakeSchedulerStalled` | `valet_prebuild_scheduler_last_pass_age_seconds > 1800` | 10m | critical |
| `ValetSandboxStartupFailures` | `sum(increase(valet_sandbox_startup_failed_total{kind!="capacity"}[15m])) > 3` | 5m | warning |
| `ValetImageFallbacks` | `sum(increase(valet_sandbox_image_fallback_total[1h])) > 0` | 0m | warning |

`ValetImageSourceUnusable` is bound-scoped on purpose: dormant test repos
with broken bakes must not page. It is expected to page during a contract
bump or a base-image cascade that runs longer than 30 minutes, because the
cascade rebakes bound repos one after another. The runbook says to confirm
that the sources page shows rebuilds in progress and to silence the alert
for the cascade instead of acting. The threshold does not change for this.
`ValetSandboxStartupFailures` excludes `kind="capacity"`: an org at its
sandbox ceiling is a product limit, not a failure. Each description links
the sources settings page by its full URL and carries the Grafana
`valet-overview` dashboard link.

Rule testing: the infra repo already runs promtool
(`tests/validate-storage.sh`). The unit tests for these rules are in
`tests/image-pipeline-rules.test.yaml`, run by
`tests/validate-image-pipeline.sh`. `make validate-alerts` runs both, and a
CI `alerts` job in `.github/workflows/validate.yml` installs promtool and
runs it. This is not part of `validate-flux-render.sh`.

Deployment: the rules ship with the platform layer through
`make apply-platform` (OpenTofu), not Flux. Merging the change does not
deploy them.

Runbook addition in `docs/runbooks/agents-dev-flux-operations.md`, section
"Image pipeline alerts": for each alert, the page to open and the
reason-to-action table from 11.2.

The "Images" dashboard row (section 9) goes into
`modules/platform/dashboards/valet-overview.json` and `valet.json` in the
same change.

## 11. Admin notifications and UI

### 11.1 Notifications

- New `AttentionKind` and `NotificationKind` value `platform`, added in
  `packages/api/src/wire/types.ts`, `packages/api/src/routes/notifications.ts`
  (`NOTIFICATION_KINDS`), and
  `packages/web/src/routes/settings.notifications.tsx`. `notifications.kind`
  is free text, so no DDL. The preferences page shows the kind only to org
  admins.
- On a transition, `setSourceHealth` calls `notifyHealthTransition`, which
  calls `routeAttention` with `owner: { type: "org", id: source.orgId }`.
  `attentionAudience` already resolves that owner to
  `org_members.role = admin`. No producer used an org owner before, so this
  path has its own tests.
- Scope: only sources that matter notify, by the same test as the bound
  gauge (`sourceMatters`): an enabled repo bound in the last 7 days, or an
  enabled base with such a repo beneath it. A disabled source
  (`enabled = false`) never matters: it posts nothing and is not counted in
  `valet.prebuild.sources.bound_unhealthy`. A source whose schedule is off
  still matters. A dormant source posts nothing; its return to `healthy`
  still drops any open episode.
- Episodes: an episode opens on the first transition into `incompatible`,
  `failing`, or `unbaked` and closes only on `healthy`. `stale` neither opens
  nor closes one. A transition that comes from a scheduler pass is
  provisional: it opens the episode, but it notifies only if the next
  scheduler pass still observes the same health and reason. A transition
  from the bake sync (a bake that failed) or from a session fallback
  notifies at once. Each reason notifies at most once per episode: a reason
  change marks the old notification read and notifies under a new key, and
  a reason that flips from A to B and back to A posts nothing new on the
  second A. Re-entering the same reason is silent (the retry loop).
  Consequences: a GitHub outage no longer pages once per bound source. A
  contract or base cascade that the scheduler resolves within one pass does
  not page. A new repository's first bake does not page unless it fails.
  Open episodes live in an in-process map.
  When the process has no entry, it seeds one from the row's previous
  unhealthy state and `health_checked_at`, so a restart during a failing
  state still closes correctly. Accepted gap: failing, then stale, then a
  process restart, then healthy posts no recovery notice and leaves the
  original notification unread, because a stale row gives nothing to seed
  from.
- Dedupe: `dedupeKey = image-source:<sourceId>:<reason>:<at>`, where `at` is
  the transition-time `health_checked_at` (6.1) of the transition that opened
  the episode or changed its reason. A fresh failure after a recovery
  therefore produces a fresh notification; repeated passes inside one
  episode do not.
- Catch-up at start: when the service starts, it runs a one-time catch-up.
  Every currently unhealthy source that matters opens a notified episode
  keyed by its stored `health_checked_at`. The first deploy therefore
  notifies once per source that is already broken and bound, and later
  restarts add nothing, because the dedupe key is the same.
- Channel delivery: the DM gate in `routeAttention` becomes
  `owner.type === "team" || kind === "platform"`. Team events and platform
  notices are web-only unless the member's `teamDm` preference for the kind
  is on; other org-owned kinds keep their channel default. `platform` uses
  the same 300 second web-first channel grace as `notification`.
- Fields: `urgency` `high` for `incompatible` and `failing`, `normal` for
  `unbaked` and recovery; title "Image for `<name>` cannot be rebuilt"
  (`failing`), "Image for `<name>` is unusable; sessions are using the stock
  image" (`incompatible`), or "Image for `<name>` has not been built yet"
  (`unbaked`); body is the guidance line plus `healthDetail`; href
  `/settings/organization/sandbox-images?source=<sourceId>`.
- Recovery: on `healthy`, `markAttentionNotificationsRead` is called with the
  episode's current key. An episode that never notified closes silently.
  For a notified episode, one `normal` notification "Image for `<name>` is
  healthy again" (key `image-source:<sourceId>:recovered:<at>`) is posted
  only if the episode, measured from its first unhealthy transition, lasted
  10 minutes or more or a session fell back from the source during it. This
  keeps flapping quiet.
- Immediate triggers: a session fallback (7.1) and a bake transition to
  `failed` (6.2) on a source that matters notify at once, without the
  provisional wait.

### 11.2 Reason to guidance

One table, `SOURCE_HEALTH_GUIDANCE` with the accessor
`sourceHealthGuidance(reason)`, in `@valet/shared`
(`packages/shared/src/source-health.ts`). The sources row, the session
banner, the notification body, and the runbook all use it. The same module
exports the `SourceHealth` and `SourceHealthReason` unions, which the api
schema and wire types re-export, and `sourceHealthPhrase` (11.3).
`packages/web/src/components/settings/source-health.ts` re-exports them and
adds the web-only tone and sort tables.

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

- Each row shows a `StatusDot` by health and the phrase from
  `sourceHealthPhrase`: "Healthy, built 2h ago", "Rebuilding", "Unusable:
  image predates the current runtime", "Failing: `<guidance>`", "Not built
  yet". The build date is the latest pushed bake's `finishedAt ?? createdAt`.
  The "Build status" sort puts unusable sources first: `failing`,
  `incompatible`, `unbaked`, `stale`, `healthy`, then disabled.
- Expanded row: current bake, commit built from, contract version and source,
  parent bake, `healthCheckedAt`, `healthDetail`, log tail, "Bake now"
  (exists), "Open bake history". `healthDetail` and the log tail are clamped
  to a fixed height and scroll.
- Query param `?source=<id>` expands that row on load and scrolls it into
  view.

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
repair: one SQL statement, `CONTRACT_BACKFILL_SQL`, with one CTE that updates
base bakes and one correlated UPDATE for repo bakes that joins the parent's
newest earlier pushed bake. Both end in `RETURNING`, and the statement
selects the union of the ids so the repair records its row count.

All schema changes ship in PR 2. PR 3 changes no schema: the only file under
`packages/api/src/schema` it touches is `index.ts`, where the duplicated
`SourceHealth` and `SourceHealthReason` unions become type re-exports from
`@valet/shared`.

## 13. Testing

- Scheduler (`source-service.test.ts`): an incompatible current bake is baked
  despite matching head and identity, on a `-c<MIN>` tag with the same
  identity; a `stuck` bake is not rebaked; a null-contract bake is re-read,
  not rebaked; the docker backend never rebakes or defers for the contract;
  a child defers on an incompatible parent; every `maybeSchedule*` exit
  writes health, including the thrown path; `health_checked_at` moves only
  on a transition; `readGithubFile` falls back to blobs on `encoding: "none"` and still
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
  includes the termination message; `kind` is set on every
  `SandboxStartupError`.
- Spec provider: fallback clears when a compatible bake resolves; the startup
  warning paragraph is present while `image_fallback` is set.
- Notifications (`attention` tests): org owner resolves to org admins only;
  same episode yields one row per admin; a new episode after recovery yields
  a new row; a reason change re-notifies; `stale` neither opens nor closes
  an episode; recovery marks the episode read; a dormant source posts
  nothing; no DM job is enqueued for a `platform` event without `teamDm`,
  and an org-owned `approval` still enqueues one.
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
   condition retry-shaped with `lastDetail`; crash-loop detail; `kind` on
   `SandboxStartupError` and the `startup_failed` counter; workflow image pin;
   and the `LABEL io.valet.sandbox.contract="3"` in the Dockerfile so the
   stock image carries it before PR 2 needs it. No schema change.
2. **valet, contract and health.** Schema repairs (section 12) with the
   backfill; `SANDBOX_IMAGE_CONTRACT` and `MIN_IMAGE_CONTRACT`; post-push
   label read; `parent_bake_id` and `base_image_ref` recording;
   `setSourceHealth` and all call sites; `contract_changed` and the `-c<MIN>`
   contract rebake tag; the kubernetes-only scheduler scope; gates in
   `resolvePrebuildImage` and `resolveBaseImage` with the callback;
   `handleImageFallback`; `image_fallback` and its clearing; startup warning
   paragraph and session note; `image_fallback` counter; zero-initialized
   counters at boot; in-process last-pass timestamp, recorded at scheduler
   start too.
3. **valet, visibility.** Wire fields (`sandboxImage`, `latestBake.finishedAt`);
   the `@valet/shared` guidance module; sources page health, guidance, deep
   link; session banner and image label; `platform` kind, org-owner fanout,
   DM gate, provisional episodes, dedupe and recovery; the one-time
   notification catch-up at start; sources gauges and scheduler age gauge.
   No schema change (section 12).
4. **test-agents-infra, alerts.** `files/image-pipeline/rules.yaml` and
   `image-pipeline-alerts.tf`; promtool unit tests, `make validate-alerts`,
   and the CI `alerts` job; runbook section; "Images" dashboard row. Applied
   with `make apply-platform`.

Expected effect at the PR 2 deploy in agents-dev: every bake built before
2026-10-26 15:20 UTC is stamped 0, the six sources still on such bakes become
`incompatible`, and the scheduler rebakes them. Sessions bound to them fall
back until the rebake pushes. Everything baked in the 2026-10-26 cascade is
stamped 3 and unaffected.

Expected effect at the PR 3 deploy: the start-up catch-up (11.1) posts one
notification per source that matters and is already unhealthy. Later restarts
post nothing new.

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

### 15.1 Amendments (2026-10-27)

Changes made during implementation, so the text above matches what was built.

- 5.3: the gate is kubernetes-only on both sides (`contractGateApplies`, `contractEnforced`); stamping runs everywhere.
- 5.4: the backfill rule is `CONTRACT_BACKFILL_SQL`: tini epoch on the bake (or the parent's earlier pushed bake), override repo bakes get `contract_source = override`.
- 6.1: `health_checked_at` means "in this state since", not "last evaluated".
- 6.2: `setSourceHealth` writes on a transition only and returns whether it transitioned; `pendingHealth` keeps one episode across failed retries; the fallback handler never overwrites a diagnosis; unclassified scheduler errors are `resolve_failed`, and `bake_failed` is only for a failed bake.
- 6.3: a contract rebake keeps the identity and uses a `-c<MIN>` tag (the parent contract does not join the identity hash); `contractRebakeFor` returns `rebake`, `reread`, or `stuck`; children defer on an incompatible parent; the docker backend never rebakes or defers for the contract; `start()` records a scheduler pass.
- 6.4, 7.4: `latestBake.finishedAt`, `SessionDetail.sandboxImage: SessionSandboxImage`, and `ImageFallback` on the wire.
- 7.1: `handleImageFallback` is idempotent per source with an in-flight map, re-reads instead of rebaking an unread label, and is a no-op on docker; the fallback write and counter are once per session and bake.
- 7.2: the prompt paragraph lasts for the session build, not while `image_fallback` is set; interactive sessions also get a `noteSessionWarning` entry.
- 8.2, 8.3: the waits use `pvcApi.readPvc`, run only after a successful destroy or when no CR exists; pod lookup matches by owner UID.
- 8.4: the ownership timeout is a `SandboxStartupError` of kind `ownership` that keeps the CR, not a plain `Error`.
- 8.7, 9: the startup counter attribute is `kind`, not `reason`, and the kinds include `capacity`.
- 9: both counters are zero-initialized at boot; the seed pass is recorded only when a builder exists, so builder-less deployments have no age series; vanished gauge series observe 0.
- 10: rules in `files/image-pipeline/rules.yaml` with promtool tests, `make validate-alerts`, and a CI job; promtool already existed; deployed by `make apply-platform`; startup alert excludes `capacity`; `ValetImageSourceUnusable` may page during long cascades (silence); dashboard row moved to PR 4.
- 11.1: notifications are scoped to enabled sources that matter (schedule off still matters); episodes open on unhealthy, close on healthy, and ignore stale; scheduler transitions are provisional until the next pass confirms them, while bake failures and fallbacks notify at once; each reason notifies at most once per episode; recovery posts only for notified episodes; accepted restart gap; DM gate is `team || platform` with a 300 s grace.
- 11.1, 14: a one-time catch-up at start notifies the existing backlog, keyed by stored `health_checked_at`; this replaces "the first pass notifies the backlog".
- 11.2, 11.3: guidance and row phrases live in `@valet/shared`; "Build status" sort, scroll-to-row deep link, clamped log tail, build date from `finishedAt ?? createdAt`.
- 12: the backfill is one statement; PR 3 changes no schema, only a type re-export.

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
