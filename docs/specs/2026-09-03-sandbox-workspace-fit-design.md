# Sandbox workspace that fits large clones

Date: 2026-09-03. Status: implemented.

## Problem

Sandboxes that clone `tkhq/mono` fail with ENOSPC. Root cause (confirmed on
agents-dev, 2026-09-03):

- The `/workspace` mount is a fixed PVC from the Sandbox CR's
  `volumeClaimTemplates` (`packages/sandbox-kubernetes/src/manifest.ts`).
  New sandboxes provision it at 1Gi (`VALET_SANDBOX_WORKSPACE_STORAGE`).
- The repo clone lands on that PVC as a FULL clone — no `--depth`, no
  `--filter` (`packages/api/src/engine/workspace-prep.ts`, `cloneFresh`).
- `tkhq/mono` is ~0.87 GB packed; a full clone (all history plus a
  working-tree checkout, peaking higher mid-clone) is ~2–3 GB on disk. It
  fills the PVC, the clone aborts, and usage drops back — so nothing shows
  as a sustained-full PVC.

Nothing auto-grew the workspace before this change. The #530
ephemeral-storage limit (8Gi) is a node-local eviction cap; it never grows
and it is not where the clone lands. A flat global size bump was declined:
a larger default is billed on every PVC in the fleet (~360 on agents-dev)
for space almost none of them use.

## Part A — blobless partial clone (primary fix)

`cloneFresh` clones with `--filter=blob:none`: all refs and commits, a full
working tree, historical blobs fetched lazily. Mono's on-disk footprint
drops from ~2–3 GB to a few hundred MB, and every large repo benefits at no
per-PVC cost.

Decisions:

- Blobless, NOT `--depth`: a shallow clone breaks `git log`, blame, and
  merge-base, which agents use. Blobless preserves them and back-fills
  blobs on demand. Blob back-fill needs the remote, which prep already has
  (the credential helper is wired sandbox-wide for fetch/checkout).
- The refresh paths' `git fetch origin` work unchanged: the partial-clone
  filter persists in the clone's git config.
- SHA-pinned refs still work: the filter omits only blobs, so the detached
  `git checkout <sha>` finds the commit and back-fills its tree's blobs.
- Prebuilt (baked) clones are out of scope: the bake Dockerfile clones at
  image-build time, off the workspace PVC.

Caveat: the working tree itself still lands on disk. A repo whose checkout
alone exceeds the workspace size needs Part B.

## Part B — on-demand workspace growth (safety net)

The default stays 1Gi. When a workspace-prep operation fails with ENOSPC on
a backend with a growable workspace, the api grows the PVC one increment
and retries the operation once.

### Engine seam

`Sandbox.growWorkspace?(): Promise<WorkspaceGrowth>` (optional, like
`suspend`/`gatewayEndpoint`). Only sandbox-kubernetes implements it;
docker/local/virtual omit it and ENOSPC surfaces as before.

### Trigger 1 (workspace prep)

`safeExecGrowRetry` in `packages/api/src/engine/workspace-prep.ts` wraps
the disk-writing git operations: fresh clone, SHA checkout, refresh
fetch/checkout, staged-prebuild fetch/checkout, and the prebuilt `cp -a`
staging. On an ENOSPC-shaped failure it calls `growWorkspace`; if the grow
lands it retries the command once (for a fresh clone, after best-effort
`rm -rf` of the partial target — never the workspace root `.`). A refused
or failed grow returns the original failure with the refusal reason
appended, so the surfaced startup error names the corrective action.

### Trigger 2 (in-run, agent commands)

Most fills happen during the run, not during prep: `pnpm install` on a
large repo writes multiples of the (blobless) clone's size. `PolicySandbox`
(`packages/engine/src/sandbox/policy.ts`) — the choke point every agent
exec and job flows through — handles this: when a command FAILS with
ENOSPC-shaped output, it confirms the workspace is actually full
(`df -P . && df -Pi .`, blocks AND inodes, ≥95%), grows once, and appends
an agent-facing note to the result ("the workspace volume was full and has
been grown — retry the command"). The df confirmation is load-bearing:
agent output can contain ENOSPC text for other reasons, and a false grow
costs a one-way doubling plus the once-per-~6h EBS window. In-process
suppression (60s) keeps a burst of failing commands to one attempt.
`PolicySandbox` also forwards `growWorkspace`/`gatewayEndpoint`, and a
compile-time guard (`Required<Sandbox>`) now forces the wrapper to forward
every future `Sandbox` method.

### Mechanism (sandbox-kubernetes)

`workspace-pvc.ts`. The agent-sandbox controller names the claim
`workspace-<crName>` (`<templateName>-<sandboxName>`, verified in the
vendored controller v0.5.1) and leaves an existing owned PVC untouched on
reconcile, so a direct merge-patch of
`spec.resources.requests.storage` never fights it. gp3 has
`allowVolumeExpansion: true` and expands ONLINE — EBS grows, the CSI
resizes the filesystem live, no pod restart. The grow waits (poll, 120s
cap) for `status.capacity.storage` to reach the new request before the
caller retries.

### Growth policy and guardrails

- Increment: double the current request, capped at
  `VALET_SANDBOX_WORKSPACE_MAX` (default 20Gi; chart value
  `sandbox.workspaceStorageMax`). At the cap the grow is refused and the
  ENOSPC fails loudly — never unbounded growth.
- Rate limit: EBS allows ~one modification per volume per 6h. Each grow
  stamps a `valet.dev/workspace-grow-at` annotation on the PVC; a grow
  inside the cooldown is refused with the remaining wait in the reason.
  The annotation survives api restarts.
- Budget: growth is one-way (a PVC cannot shrink), so
  `max × VALET_ORG_SANDBOX_CEILING` bounds what one org can accrete.
- Visibility: every grow attempt records the
  `valet.sandbox.workspace_grow` counter (outcome: grown/refused/error)
  and a log line. Successes record too, so the
  `SandboxWorkspacesFillingSystemic` alert (5+ workspaces filling at once)
  still surfaces a systemic problem instead of being papered over.
- RBAC: the api's namespaced sandbox-operator Role gains
  `persistentvolumeclaims: get, patch` only. PVC create/delete stay with
  the agent-sandbox controller.

## Part C — repo-declared workspace size (TKAI-385)

A repo whose footprint is KNOWN should never lean on reactive growth (one
EBS-rate-limited doubling per ~6h). It declares its size instead:

```yaml
# .valet/prebuild.yaml
workspaceStorage: "4Gi"
```

- The declaration lives in `.valet/prebuild.yaml` because that file is
  already the repo-owned config read at session create time, BEFORE any
  clone exists (the `docker` key set the precedent for a session-runtime
  knob there). `repoPrebuildFlags` (`packages/api/src/bakes/source-service.ts`)
  reads both keys in one cached (10 min), best-effort, 5s-bounded GitHub
  contents call; any failure degrades to the defaults.
- The value flows `EngineHost.resolveRepoPrebuildFlags` →
  `SandboxCreateOpts.workspaceStorage` → the manifest builder
  (`resolveWorkspaceStorageRequest`), which CLAMPS it to
  `VALET_SANDBOX_WORKSPACE_MAX` — a repo cannot request unbounded storage —
  and falls back to the deploy default on any unparseable quantity (a
  typo'd cap must never grant the request).
- Quantity comparison accepts the `resource.Quantity` forms that Kubernetes
  uses. These are DecimalSI (`n`, `u`, `m`, empty, `k`, `K`, `M`, `G`, `T`,
  `P`, `E`), BinarySI (`Ki` through `Ei`), and signed decimal exponents.
  The comparison rounds fractional byte counts away from zero. It rejects
  negative, non-finite, and unsafe byte counts.
- Only a FRESH claim is affected: the agent-sandbox controller leaves an
  existing owned PVC untouched, so restores/adoptions keep their size.
- Create-time sizing costs no EBS modification. Reactive growth (Part B)
  stays as the safety net below the declared size, and starts its doubling
  from it.
- Only the PRIMARY (position-0) binding's declaration is read, matching the
  `docker` key's existing behavior.

Schema doc: `docs/prebuild-yaml.md`. Immediate use: set `tkhq/mono` to
`"4Gi"` and the clone never fills the volume at all.

## Agent-visible behavior of blobless clones

- Operations that read historical blobs (`git blame`, `git log -p`,
  `git show <old-sha>:<path>`, `git diff <old-sha>`) now fetch blobs from
  the remote on demand. They need working credentials at USE time, not
  just at clone time, and on large-history files they are slow (one fetch
  round trip per missing blob batch).
- The credential helper warns on stderr when it has no usable token, so a
  lazy-fetch failure names the corrective action ("restart the session")
  instead of surfacing only as `unable to read <sha>`.
- An agent that needs heavy history archaeology can hydrate once:
  `git config --unset remote.origin.partialclonefilter` then
  `git fetch --refetch origin`. The working set then accretes on the PVC
  like a full clone.
- Lazy-fetched blobs accumulate in `.git/objects` on the persistent
  volume, and nothing runs `git maintenance`; a long-lived workspace
  converges back toward full-clone size. The growth cap bounds the disk
  consequence.

## Deviations & follow-ups

- Shipped broken, fixed same week: `EngineHost.resolveRepoPrebuildFlags`
  only proceeded when the primary binding's host was `"github.com"`, but
  `session_repos.host` stores `"github"` (the schema default). Every bound
  session silently resolved default flags — `workspaceStorage` never reached
  the claim, and the repo `docker` flag (same guard since its introduction)
  never applied. The guard now accepts both spellings via the exported
  `primaryGitHubRepoTarget`, logs the skip when a host is genuinely not GitHub,
  and `host.prebuild-flags.test.ts` pins the schema default through
  `loadSessionMeta` into the guard.
- Second miss, same week: `buildChildSession` (the orchestrator-spawned
  child path) assembled its own sandbox opts and never called
  `resolveRepoPrebuildFlags` at all — children bound to a repo provisioned
  the 1Gi default claim while REST-created sessions honored the declaration.
  The child builder now runs the same read, and the same test file drives
  `childSessionFor` end to end against a GitHub fixture. Workflow sessions
  (`buildWorkflowSession`) still load no repo bindings and read no flags —
  open follow-up if workflow sessions ever clone repos.
- In-run growth is reactive (a command must fail once). Proactive growth
  from the kubelet volume stats already in Prometheus (grow at a
  threshold, before anything fails) remains open — TKAI-381.
- The `valet.sandbox.workspace_grow` counter has no bundled dashboard
  panel or alert rule yet. Prep-time fills are transient (git cleans up),
  so the kubelet-stats `SandboxWorkspacesFillingSystemic` alert does not
  see them; the counter is currently the ONLY signal for this class. Add
  an infra alert on its rate, and a dashboard panel.
- Growth ramps slowly by design (double per ~6h per volume). A session
  that needs several doublings (a multi-GiB prebuilt bake staged onto a
  1Gi claim) fails for multiple cooldown cycles. Part C (the repo-declared
  size, TKAI-385) is the manual fix; INFERRED create-time sizing from
  known inputs (the bake row's staged size, GitHub's packed repo size)
  remains open — TKAI-382.
- Grown PVCs are invisible to capacity planning: nothing reports
  provisioned-vs-used or counts grown volumes. The
  `valet.dev/workspace-grow-at` annotation makes grown claims queryable;
  a periodic gauge would close the gap. Long-lived daily-active sessions
  (orchestrators, assistants) ratchet monotonically — resets happen only
  on destroy/reap paths.
- During a large fan-out onto one repo, many PVCs grow at once; the
  external-resizer queue and account-level EBS ModifyVolume throttling can
  push individual grows past the 120s wait. Those record outcome
  `wait_timeout` (the resize completes in the background; the next start
  attempt usually succeeds without growing).

## Out of scope

- Node ephemeral storage (DinD emptyDir, container rootfs) — bounded by
  the #530 limits, a separate concern from the workspace PVC.
- Shrinking workspaces (EBS cannot; reclaim/recreate is the only way
  down).
- A flat global `workspaceStorage` bump (explicitly declined — billed per
  PVC fleet-wide).

## Acceptance

- A sandbox clones `tkhq/mono` on a 1Gi default: Part A keeps the clone
  small; if the working tree still exceeds the current size, Part B grows
  the PVC (up to the cap) and the retry succeeds — no manual intervention.
- Growth is capped and rate-limited; a runaway workload hits the cap and
  fails loudly with the cap named in the error.
- `SandboxWorkspacesFillingSystemic` still fires when many workspaces fill
  at once (the grow metric records every fill event, grown or not).
