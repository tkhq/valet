# Sandbox Reconciliation Design — declarative sandboxes + unified image generation

**Date:** 2026-08-02
**Status:** Approved design, not yet implemented
**Scope:** Replaces the imperative sandbox-prep lifecycle with a declarative spec + reconcile model, so sandboxes converge to current platform state (new images, new prep, fresh bakes) transparently — no buttons, no manual pod deletion. Unifies the image catalog, prebuild configs, and prebuild records into one source → image chain. Amends `2026-07-15-sandbox-images-v2-design.md` (generation path) and the prep model from `2026-07-16-github-repo-integration-design.md`; composes with `2026-07-15-sandbox-hibernation-warm-pools-design.md` (wake folds into reconcile).

## Context

- Deploys change the sandbox world constantly: new shim scripts, new prep steps, new stock images, fresh prebuild bakes. Running sandboxes never pick any of it up. The fix during development has been manual pod deletion — the exact failure mode this spec removes.
- The current model is imperative: create a sandbox, run a `prepareSandbox` closure once per (sandbox, epoch), hope nothing drifts. Drift is invisible: a crashed-and-restarted pod comes back with a fresh container filesystem (prep artifacts gone) and the engine never notices.
- The workspace volume (k8s PVC, docker bind-mount) already survives pod replacement. Real state lives there; the container filesystem is disposable. The architecture just doesn't exploit that yet.
- The prebuild subsystem (sandbox-images-v2) works but has three overlapping nouns (catalog entries, `prebuild_configs`, `prebuilds`), no org-level base image, admin-only setup, and a nightly schedule that rebuilds even when nothing changed.

## The model

One sentence: **a sandbox is a cache materialization of a pure spec over a durable workspace, and `reconcile` is the only verb.**

### Nouns

| Noun | Definition |
|---|---|
| **Workspace** | The durable volume (PVC / bind-mount) and its identity. The only stateful thing. Sessions own workspaces; sandboxes borrow them. |
| **SandboxSpec** | Desired state: `{ image, prep: PrepStep[] }`. Computed by one pure function; hashed (`specHash`). |
| **PrepStep** | A named, content-hashed, **convergent** unit of prep: `{ id, hash, critical, apply }`. "Make true," not "do once." |
| **Applied state** | `/etc/valet/applied.json` inside the sandbox: the step hashes that have been applied. The sandbox carries its own observed record — it survives api restarts for free, and an empty file after a pod restart is self-describing divergence. |
| **ImageSource** | A declarative recipe for producing images, with a parent pointer: `stock`/`external` (raw ref, no build), `base` (FROM parent + org setup commands), `repo` (FROM parent + repo + recipe). |
| **Image** | A content-addressed bake produced from a source. Each source has one *current* image. |

### Verbs

| Verb | Definition |
|---|---|
| **reconcile** | Observe (applied state + running image) → diff against `computeSpec` → converge, within policy. The only sandbox lifecycle verb above the provider port. |
| **bake / skip** | The nightly job per source: recompute identity + head SHA; bake when either moved, skip when both match the current image. |
| **prune** | Retention, unchanged from sandbox-images-v2 (keep last 2 per source). |

## Decisions (locked)

1. **`computeSpec(sessionMeta) → SandboxSpec` is a pure function.** It consolidates what today lives across `buildSession`, `resolvePrebuildImage`, and the two prep builders (`buildWorkspacePrep`, `buildCredentialOnlyPrep`). No side effects; deterministic; golden-tested on `specHash`. Image resolution walks the source chain: repo source current image → org base current image → stock ref.

2. **Prep is data, not a closure.** `CreateSessionOptions.prepareSandbox` is replaced by an injected `SpecProvider` (one seam; also subsumes any staleness-probe concept). The provider returns the ordered `PrepStep[]`. A step's hash covers its **configuration** (script text, repo URL, auth mode) — never world state (head SHA), so upstream pushes do not churn prep; freshness stays inside the clone step (fetch-on-start, unchanged). Steps must be convergent; the existing prep bodies already are (clone-if-cold/fetch-if-exists, cp-overwrite installs).

3. **Reconcile diff cases:**
   - image differs → replace the pod: `provider.release()` + `provider.create()` under the same workspace. **Never `destroy()`** — on kubernetes, destroy cascade-deletes the PVC. Epoch increments; all steps re-apply.
   - only some step hashes differ → re-run exactly those steps **in place**. A shim fix converges in seconds with zero state loss and no pod replacement.
   - applied file missing/empty (pod restarted, fresh container fs) → re-apply all steps.
   - hibernated and stale → skip resume, provision fresh. Wake is not a separate path; it is reconcile.
   - sandbox age > 20h → treated as diverged (locked call **b**). A daily idle-window recycle keeps the 24h sandbox token fresh — the known token-strand gap becomes routine reconciliation.

4. **`ensureReady` stays the single funnel; `mayReplace` is the policy bit.** Mid-run acquisitions call `reconcile({ mayReplace: false })` — prep-only convergence at most, never a pod swap under a live command. The first acquisition of a run grants `mayReplace: true`. Busy = active runs across **all** threads + pending exec jobs. Gateway terminal/VS Code connections are NOT consulted this pass (documented limitation: a refresh drops an open terminal into a fresh pod).

5. **Convergence-failure memo.** The attachment records (specHash, failedAt) on a failed replacement and backs off (exponential, cap ~30 min) so an unpullable image degrades to "keep running the old sandbox," not "cold-boot stall on every prompt." Divergence age (`now - firstObservedDivergence`) is a metric; a force-replace valve for starving busy sessions is future work.

6. **Reconcile is wired only when `capabilities().isolated`** — local/virtual backends exec against the host and get none of this, same gate as credential-only prep.

7. **Source of truth for the running image moves to the attachment.** `CreateSessionOptions.image` is demoted to an initial value; after any replacement the attachment's observed image is authoritative. The cached-session-opts-vs-running-pod drift bug class becomes unrepresentable.

8. **Prep failure semantics carry over as per-step `critical` flags** (locked call **c**): clone steps are critical (failure → startup-failure semantics, unchanged); credential/shim steps degrade quietly (log, continue), matching current credential-only prep behavior. A failed step stops the plan; applied.json records the successes; the next window retries from the failure.

9. **Generation path: `image_sources` + `images` replace catalog entries + `prebuild_configs` + `prebuilds`** (locked call **a**; pre-1.0, tables restructured in the `0000` migrations in place). Sources chain by parent id. The admin image catalog becomes `external` sources. Build records become `images` rows keyed by source + identity hash + commit SHA. `PrebuildService`, its routes, and the settings UI rework accordingly ("Sandbox images" surface lists sources and their bake history).

10. **Org base source.** At most one `base` source per org; org-admin edits its setup command list in settings. Identity = parent identity + commands hash — the nightly job therefore skips unless the commands or the stock image changed. Unbound sessions (orchestrators, ad-hoc chat) resolve to the base source's current image; this is the durable home for "the sandbox never has python3/jq/cc."

11. **Zero-config repo sources.** Binding a repo to a session auto-creates its `repo` source (enabled, nightly, parent = org base source if one exists, else stock) and kicks the first bake in the background — gated on: an org-scoped GitHub credential resolvable (installation/PAT; user-only cannot build, existing invariant) AND an `ImageBuilder` configured. Session create never waits on a bake.

12. **Content-addressing is the contract between paths.** Every image the sandbox path consumes is a content-addressed output of the generation path (bake tags derive from identity + commit SHA), so "did the image change" is a string compare. Degraded corner: an org with no builder falls back to the raw stock ref, where a same-tag rebuild is invisible to reconcile — documented; deployments that care pin a digest in `VALET_SANDBOX_IMAGE`.

## What this kills

- The `provisionStamp` session column idea — observed state lives in the sandbox's applied file, not the database.
- `prepareSandbox` closure and any separate staleness-probe seam — one `SpecProvider` injection.
- Special-case wake/refresh coordination — one verb.
- Manual pod deletion after deploys.

## Sequencing

Phases 1–3 are the sandbox path and land independently of phase 4; the current prebuild tables keep working underneath until then.

1. **Spec extraction.** `computeSpec` + `specHash` goldens. Pure refactor; no behavior change.
2. **PrepPlan in the engine.** `SpecProvider` seam, step model, applied.json, in-place step convergence. Conformance suites updated. Ships standalone value: shim deploys stop requiring pod deletion.
3. **Replacement.** `mayReplace` windows in the run loop, release+create preserving workspace, wake folding, backoff memo, 20h age policy, divergence-age metric.
4. **Generation unification.** `image_sources`/`images` tables, org base source + settings editor, zero-config auto-create, nightly bake-or-skip, retention ported, UI relabel.

## Exit criteria (the dogfood)

On the local k8s deploy: edit a shim script, deploy — next prompt on a running session converges in place (no pod replacement, applied.json updated, new shim present). Push a new stock image tag — next prompt replaces the pod; a file written in `/workspace` beforehand survives, a file written in `/root` does not. Kill a sandbox pod manually — next prompt re-applies all steps without replacement. Edit the org base commands — nightly (or manual) bake produces a new base image, repo sources rebake on their next nightly pass, sessions pick both up lazily. Bind a fresh repo — source auto-created, first bake runs in background, second session on that repo boots prebuilt. Two consecutive nightly passes with no upstream commits — second pass skips every source. A sandbox older than 20h gets recycled in an idle window and its git credential helper still mints (fresh token).

## Testing

- **Spec unit:** `computeSpec` determinism goldens; hash changes exactly when script text / resolution inputs change; step hashes exclude world state (head SHA moves → no prep diff).
- **Engine unit:** reconcile diff matrix (image / subset-of-steps / empty-applied / age); `mayReplace: false` never replaces; busy signals (runs + jobs) block replacement; backoff memo; critical vs non-critical step failure; epoch semantics preserved.
- **Conformance:** replace-preserves-workspace added to the provider suites (docker bind-mount + cluster-gated PVC variants).
- **Integration:** newer bake → lazy replacement on next prompt; wake-when-stale skips resume; api-restart amnesia (observed state re-read from applied.json).
- **Generation:** source chain resolution, identity hashing, bake-or-skip matrix, zero-config gating (no creds → no source; no builder → no source), retention ported.

## Out of scope (named, deliberate)

- Gateway-connection-aware busy signals (terminal drops are tolerated).
- Force-replacement for perpetually-busy sessions (metric first).
- Push-webhook-triggered bakes (nightly + manual only, per user decision).
- In-place env/token refresh into a live container (the 20h recycle bounds the problem instead).
- Warm pools keyed on current resolution (Stage 2 of the hibernation spec; noted so pool keys use source identity, not raw image refs).
