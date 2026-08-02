# Sandbox Reconciliation Design — declarative sandboxes + unified image generation

**Date:** 2026-08-02
**Status:** Approved design (revised after adversarial review), not yet implemented
**Scope:** Replaces the imperative sandbox-prep lifecycle with a declarative spec + reconcile model, so sandboxes converge to current platform state (new images, new prep, fresh bakes) transparently — no buttons, no manual pod deletion. Adds a live-updatable credentials mount so token rotation never requires replacement. Unifies the image catalog, prebuild configs, and prebuild records into one source → bake chain. Amends `2026-07-15-sandbox-images-v2-design.md` (generation path) and the prep model from `2026-07-16-github-repo-integration-design.md`; composes with `2026-07-15-sandbox-hibernation-warm-pools-design.md` (wake folds into reconcile).

## Context

- Deploys change the sandbox world constantly: new shim scripts, new prep steps, new stock images, fresh prebuild bakes. Running sandboxes never pick any of it up. The fix during development has been manual pod deletion — the exact failure mode this spec removes.
- The current model is imperative: create a sandbox, run a `prepareSandbox` closure once per (sandbox, epoch), hope nothing drifts. Drift is invisible: a crashed-and-restarted pod comes back with a fresh container filesystem (prep artifacts gone) and the engine never notices.
- The workspace volume (k8s PVC, docker bind-mount) already survives pod replacement. Real state lives there; the container filesystem is disposable. The architecture just doesn't exploit that yet.
- The 24h sandbox-token TTL strands long-lived sandboxes (`2026-07-16` spec, known open issue): the token lives in pod env, which is only settable at pod creation.
- The prebuild subsystem (sandbox-images-v2) works but has three overlapping nouns (catalog entries, `prebuild_configs`, `prebuilds`), no org-level base image, admin-only setup, and a nightly schedule that rebuilds even when nothing changed.

## The model

One sentence: **a sandbox is a cache materialization of a pure spec over a durable workspace, credentials are live-mounted runtime config, and `reconcile` is the only verb.**

### Nouns

| Noun | Definition |
|---|---|
| **Workspace** | The durable volume (PVC / bind-mount) and its identity. The only stateful thing. Sessions own workspaces; sandboxes borrow them. |
| **SandboxSpec** | Desired state: `{ image, prep: PrepStep[] }`. Computed by a pure function over an explicit snapshot; hashed (`specHash`). |
| **PrepStep** | A named, content-hashed, **convergent** unit of prep: `{ id, hash, critical, apply }`. "Make true," not "do once." |
| **Applied state** | `/etc/valet/applied.json` inside the sandbox: `{ image, specHash, steps: {id: hash} }`, written by the reconciler after convergence. The sandbox carries its own COMPLETE observed record — `provider.restore()` reports no image, so this file is the only source of the running image after an api restart. Empty/missing after a pod restart is self-describing divergence. |
| **Creds mount** | `/etc/valet/creds/` — a per-sandbox live-updatable file mount (k8s Secret volume; docker/local host-dir bind mount; virtual in-memory). Holds the sandbox token. Runtime config, NOT prep state: always current at pod boot, updatable without exec or replacement. |
| **ImageSource** | A declarative recipe for producing bakes, with a parent pointer: `stock`/`external` (raw ref, no build), `base` (FROM parent + org setup commands), `repo` (FROM parent + repo + recipe). |
| **Bake** | A content-addressed build output of a source; each `bakes` row points at an OCI image ref. Each source has one *current* bake. (Named "Bake," not "Image," to avoid overloading the raw OCI term.) |

### Verbs

| Verb | Definition |
|---|---|
| **reconcile** | Observe (applied state + running image) → diff against the spec → converge, within policy. The only sandbox lifecycle verb above the provider port. Single-flight per attachment. |
| **rotate** | A periodic host sweep (hourly): re-mint the sandbox token for every live sandbox whose token passed ~12h and push it through the creds mount. Sweep-driven, NOT run-start-triggered — rotating at the prompt would race Secret propagation (~1 min) against an already-expired token on long-idle sandboxes. Needs no idle window and no replacement. |
| **bake / skip** | The nightly job per source: recompute identity + head SHA; bake when either moved, skip when both match the current bake. |
| **prune** | Retention, unchanged from sandbox-images-v2 (keep last 2 per source). |

## Decisions (locked)

1. **Spec computation is pure over an explicit snapshot.** A thin resolver gathers `ResolveSnapshot` (session meta, each relevant source's current bake, env config: stock ref, api URL); `computeSpec(snapshot) → SandboxSpec` is pure and deterministic over it. This factoring is what the `specHash` goldens test — no mocking, no hidden DB reads inside the pure part. It consolidates what today lives across `buildSession`, `resolvePrebuildImage`, and the two prep builders. Image resolution walks the source chain: repo source current bake → org base current bake → stock ref.

2. **Prep is data, not a closure.** `CreateSessionOptions.prepareSandbox` is replaced by an injected `SpecProvider` (one seam; also subsumes any staleness-probe concept). The provider returns the ordered `PrepStep[]`. A step's hash covers its **configuration** (script text, repo URL, auth mode) — never world state (head SHA), so upstream pushes do not churn prep; freshness stays inside the clone step (fetch-on-start, unchanged). Steps must be convergent; the existing prep bodies already are (clone-if-cold/fetch-if-exists, cp-overwrite installs).

3. **Reconcile diff cases:**
   - image differs → replace: re-create under the same workspace. The invariant is WORKSPACE SURVIVAL, and each provider meets it its own way: kubernetes uses `release()` + `create()` and must never `destroy()` (destroy cascade-deletes the PVC); docker may `destroy()` + `create()` (the bind-mounted workspace survives container removal). Epoch increments; all steps re-apply.
   - only some step hashes differ → re-run exactly those steps in place. A shim fix converges in seconds with zero state loss and no pod replacement.
   - applied file missing/empty/corrupt (pod restarted, fresh container fs) → re-apply all steps.
   - hibernated and stale → skip resume, provision fresh. Wake is not a separate path; it is reconcile.
   - There is NO age-based divergence. Token freshness is `rotate`'s job (decision 5); container state lives until a real diff appears.

4. **All convergence happens at the run-start window; mid-run `ensureReady` is a pure fast-path.** The first acquisition of a run grants the window; reconcile (single-flight) may replace the pod or run steps there. Every later acquisition in the run does neither — no step convergence mid-run (the clone step's fetch+checkout under a live command would corrupt the working tree; distinguishing "safe" steps buys nothing). Busy = active runs across **all** threads + pending exec jobs. Gateway terminal/VS Code connections are NOT consulted this pass (documented limitation: a replacement drops an open terminal into a fresh pod).

5. **Credentials ride the creds mount, not env and not prep.** Shims read `/etc/valet/creds/token` first, `$VALET_SANDBOX_TOKEN` env as fallback (back-compat with pre-mount sandboxes). The port gains `SandboxProvider.updateCreds(sandboxId, files: Record<string, string>)` and `capabilities().credsMount: boolean`:
   - kubernetes: per-sandbox Secret, mounted as a **whole-directory volume** (env-from-Secret is frozen at process start; subPath mounts never update — both are traps, both prohibited here). Rotation = PATCH the Secret; kubelet propagates within ~1 min, which is fine against a 24h TTL rotated at 12h.
   - docker/local: a second small host-dir bind mount; rotation = write the host file (instant). Docker mounts are immutable after create — existing containers gain the mount on their next replacement; env fallback covers the gap.
   - virtual: in-memory.
   The `rotate` sweep (verbs table) drives updates hourly, so tokens are always fresh regardless of run activity. A restarted pod mounts the CURRENT secret at boot, so credentials are fresh before any prep runs. This closes the 24h token-strand gap properly and removes the motivation for age-based recycling. Providers without `credsMount` keep today's env-only behavior and its documented TTL limitation. Gateway processes (ttyd/code-server auth) still read env; migrating them to the mount is future work.

6. **Observation is cached and throttled.** The attachment caches observed state (applied hashes, running image) in memory; the applied file is re-read via exec only (a) after a provisioning/ready transition and (b) on a ~5 min throttle. The throttle bounds pod-restart detection latency — a restarted pod may run up to ~5 min with missing prep artifacts before the next run-start window catches it. Explicit trade: per-prompt exec cost vs restart-detection latency.

7. **Convergence-failure memo.** The attachment records (specHash, failedAt) on a failed replacement and backs off (exponential, cap ~30 min) so an unpullable bake degrades to "keep running the old sandbox," not "cold-boot stall on every prompt." The memo is in-memory; an api restart clears it (acceptable: one retry per session after deploy). Divergence age (`now - firstObservedDivergence`) is a metric; a force-replace valve for starving busy sessions is future work.

8. **Reconcile is wired only when `capabilities().isolated`** — local/virtual backends exec against the host and get none of this, same gate as credential-only prep.

9. **Source of truth for the running image moves to the attachment.** `CreateSessionOptions.image` is demoted to an initial value; after any replacement the attachment's observed image is authoritative. `agent_sessions.prebuild_id` demotes to historical observability (which bake the session FIRST booted from); it no longer implies the running image. The cached-session-opts-vs-running-pod drift bug class becomes unrepresentable.

10. **Prep failure semantics carry over as per-step `critical` flags:** clone steps are critical (failure → startup-failure semantics, unchanged); credential/shim steps degrade quietly (log, continue), matching current credential-only prep behavior. A failed step stops the plan; applied.json records the successes; the next window retries from the failure.

11. **Generation path: `image_sources` + `bakes` replace catalog entries + `prebuild_configs` + `prebuilds`** (pre-1.0, tables restructured in the `0000` migrations in place). Sources chain by parent id. The admin image catalog becomes `external` sources. Build records become `bakes` rows keyed by source + identity hash + commit SHA. `PrebuildService`, its routes, and the settings UI rework accordingly ("Sandbox images" surface lists sources and their bake history). Data stance (pre-1.0): existing `prebuild_configs`/`prebuilds` rows are DROPPED, not migrated — repo sources re-materialize via zero-config on next bind, the org base source starts empty, and phase 4 must not invent a migration.

12. **Org base source.** At most one `base` source per org; org-admin edits its setup command list in settings. Identity = parent identity + commands hash — the nightly job therefore skips unless the commands or the stock image changed. Unbound sessions (orchestrators, ad-hoc chat) resolve to the base source's current bake; this is the durable home for "the sandbox never has python3/jq/cc."

13. **Zero-config repo sources, with decay.** Binding a repo to a session auto-creates its `repo` source (enabled, nightly, parent = org base source if one exists, else stock) and kicks the first bake in the background — gated on: an org-scoped GitHub credential resolvable (installation/PAT; user-only cannot build, existing invariant) AND an `ImageBuilder` configured. Session create never waits on a bake. The nightly job skips (auto-disables) a source only when NO live session has its repo bound AND no new bind happened in 30 days — binding is an event, use is ongoing, and a repo an orchestrator bound months ago but still works in daily must keep baking. The next bind re-enables. A repo touched once does not cost a BuildKit job every night forever.

14. **The nightly job walks sources parent-first in one pass.** A base bake and its dependent repo rebakes land the same night, not across two.

15. **Uniform clone layout: repo-bound sessions always clone into `<repo>/` subdirectories.** The single-repo-at-workspace-root special case is removed for NEW sessions (pre-1.0 behavior change) — a root-resident clone makes dynamic repo attach incoherent (the workspace root IS the first repo's working tree, so a second repo could only nest inside it). Each binding's target directory is computed once at bind time and persisted on its `session_repos` row; convergence never relocates a working tree, so sessions created before this change keep their root layout and simply cannot dynamic-attach. Collision disambiguation (`owner__repo`) is unchanged.

16. **Content-addressing is the contract between paths.** Every image ref the sandbox path consumes is a content-addressed output of the generation path (bake tags derive from identity + commit SHA), so "did the image change" is a string compare. Degraded corner: an org with no builder falls back to the raw stock ref, where a same-tag rebuild is invisible to reconcile — documented; deployments that care pin a digest in `VALET_SANDBOX_IMAGE`.

## Topology

The unit of reconciliation is the **attachment**, not the session. All per-sandbox state (epoch, observed state, backoff memo, creds mount, target spec) lives in the attachment; sessions hold attachments. Keep it that way — no new code may key sandbox state by session id where it means attachment id.

- **A session owns a set of sandbox slots; today exactly one (`default`).** `SpecProvider` computes a spec per slot. Multi-sandbox agents are a future composition of attachments, not a lifecycle change — the blocked work is the tool surface (bash targeting, per-sandbox terminals, event dimensions), which is out of scope here.
- **Many repos in one sandbox is the encouraged topology for cross-repo work**, and reconcile improves it: clone steps are per-binding, so binding a repo to a RUNNING session is a spec diff that converges at the next window — dynamic repo attach with no session recreate (requires the uniform subdirectory layout, decision 15). Removing a binding drops the step but leaves the directory (convergence never deletes user state). Bakes cover the primary binding only; composite multi-repo bakes are out of scope (combinatorial identity explosion).
- **Single-writer invariant: exactly one attachment owns a sandbox.** Shared sandboxes across agents have no natural owner for the convergence window and invite concurrent checkout corruption; cross-agent collaboration composes through repos (topology above) or git, not shared pods.

## Named risks (verify FIRST in phase 3)

Both live in the vendored agent-sandbox controller (`deploy/`), which we own and can extend:

1. **CR image patch must actually roll the pod.** Replacement upserts the Sandbox CR with a new image. If the controller treats the CR as create-once and ignores image updates, replacement silently no-ops while reconcile believes it converged. Verify on the live cluster before building phase 3; if unsupported, extend the controller (preferred) or fall back to pod-delete + CR-patch.
2. **The CR must support a Secret volume mount** for the creds mount. If the CR schema has no volume seam, extend the vendored CRD/controller.

## What this kills

- The `provisionStamp` session column idea — observed state lives in the sandbox's applied file, not the database.
- `prepareSandbox` closure and any separate staleness-probe seam — one `SpecProvider` injection.
- Special-case wake/refresh coordination — one verb.
- Age-based sandbox recycling — rotation through the creds mount makes it unnecessary.
- The 24h token-strand gap (for `credsMount` providers).
- Manual pod deletion after deploys.

## Sequencing

Phases 1–3 are the sandbox path and land independently of phase 4; the current prebuild tables keep working underneath until then.

1. **Spec extraction.** `ResolveSnapshot` + `computeSpec` + `specHash` goldens. Pure refactor; no behavior change.
2. **PrepPlan in the engine.** `SpecProvider` seam, step model, applied.json, in-place step convergence at run start. Conformance suites updated. Ships standalone value: shim deploys stop requiring pod deletion.
3. **Replacement + creds mount.** Verify the two named risks first. Then: run-start windows, release+create preserving workspace, wake folding, backoff memo, divergence-age metric, `updateCreds` port + Secret/bind-mount implementations + shim file-first read + rotate loop.
4. **Generation unification.** `image_sources`/`bakes` tables, org base source + settings editor, zero-config auto-create with decay, parent-first nightly bake-or-skip, retention ported, UI relabel.

## Exit criteria (the dogfood)

On the local k8s deploy: edit a shim script, deploy — next prompt on a running session converges in place (no pod replacement, applied.json updated, new shim present). Push a new stock image tag — next prompt replaces the pod; a file written in `/workspace` beforehand survives, a file written in `/root` does not. Kill a sandbox pod manually — the divergence is OBSERVED within one throttle window, all steps re-apply at the next prompt (convergence only happens in the run-start window, decision 4), and the restarted pod booted with the CURRENT token from the Secret mount. A sandbox older than 12h has a rotated token file and its credential helper still mints — with no pod replacement having occurred. Edit the org base commands — the next nightly pass bakes the base AND rebakes dependent repo sources the same night; sessions pick both up lazily. Bind a fresh repo — source auto-created, first bake runs in background, second session on that repo boots prebuilt. Two consecutive nightly passes with no upstream commits — second pass skips every source. A repo unbound for 30 days stops baking; re-binding resumes it.

## Testing

- **Spec unit:** `computeSpec` determinism goldens over fixed snapshots; hash changes exactly when script text / resolution inputs change; step hashes exclude world state (head SHA moves → no prep diff).
- **Engine unit:** reconcile diff matrix (image / subset-of-steps / empty-applied / corrupt-applied); mid-run acquisitions never converge anything; single-flight under concurrent run starts across threads; busy signals (runs + jobs) block the window; backoff memo; critical vs non-critical step failure; epoch semantics preserved; observation throttle honored.
- **Conformance:** replace-preserves-workspace and `updateCreds` visibility added to the provider suites (docker bind-mount instant; cluster-gated PVC survival + Secret propagation ≤ ~90 s).
- **Integration:** newer bake → lazy replacement on next prompt; wake-when-stale skips resume; api-restart amnesia (observed image + steps restored from applied.json — `restore()` reports no image; backoff memo cleared → exactly one retry); shim reads file-first/env-fallback.
- **Generation:** source chain resolution, identity hashing, parent-first ordering, bake-or-skip matrix, zero-config gating (no creds → no source; no builder → no source), 30-day decay + re-enable, retention ported.

## Out of scope (named, deliberate)

- Gateway-connection-aware busy signals (terminal drops on replacement are tolerated).
- Force-replacement for perpetually-busy sessions (metric first).
- Push-webhook-triggered bakes (nightly + manual only, per user decision).
- Migrating gateway env consumers (ttyd/code-server auth) to the creds mount.
- Warm pools keyed on current resolution (Stage 2 of the hibernation spec; noted so pool keys use source identity, not raw image refs).
- Multi-sandbox sessions (slots stay singular this pass) and composite multi-repo bakes.
