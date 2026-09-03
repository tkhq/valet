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

### Trigger (workspace prep)

`safeExecGrowRetry` in `packages/api/src/engine/workspace-prep.ts` wraps
the disk-writing git operations: fresh clone, SHA checkout, refresh
fetch/checkout, staged-prebuild fetch/checkout, and the prebuilt `cp -a`
staging. On an ENOSPC-shaped failure it calls `growWorkspace`; if the grow
lands it retries the command once (for a fresh clone, after best-effort
`rm -rf` of the partial target — never the workspace root `.`). A refused
or failed grow returns the original failure with the refusal reason
appended, so the surfaced startup error names the corrective action.

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
