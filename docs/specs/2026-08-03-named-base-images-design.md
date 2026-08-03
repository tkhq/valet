# Named Base Images + Cache Management Design

**Date:** 2026-08-03
**Status:** Approved design, not yet implemented
**Scope:** Replace the single org base image with multiple named, language-specific base images (Python / Rust / JS), auto-selected per repo like Heroku buildpack detection — one stack detected, switchable by the user. Add bounded cache management so baked images cannot fill the node's disk. Amends `2026-08-02-sandbox-reconcile-design.md` (generation path: decisions 11-15) and `2026-07-15-sandbox-images-v2-design.md` (recipe detection).

## Context

- Today there is exactly ONE base source per org (partial unique index `image_sources_org_base WHERE kind='base'`). Every repo prebuild chains `FROM` it. A repo that needs Rust and a repo that needs Python cannot both be served well by one base.
- The live dogfood proved the need: a JS repo baked cleanly on a node base, but a Rust repo failed (`cargo: not found`) until Rust was added to the single base — which would then bloat every non-Rust sandbox.
- The same dogfood hit a real disk-pressure incident: cumulative baking filled the single-node cluster; kubelet image GC evicted the api's local-only image and took the api down. Baked images accumulate in the registry and node store; with multiple bases × many repos this multiplies.

## The model (Heroku-style)

Detect one stack per repo from its lockfiles, build the repo prebuild `FROM` that stack's base image, and let the user switch the base if the guess is wrong. Bases materialize on demand from built-in templates; storage is bounded by a retention floor and a global size ceiling.

## Decisions (locked)

1. **Multiple named bases per org.** Drop the `image_sources_org_base` unique index. A `base` source gains a nullable `template` column (`"rust" | "python" | "js" | null`): built-in bases carry their template name; admin-authored custom bases are `null`. Name stays the human label. Everything else in the source/bake model (parent chain, bakes, `resolveParentBase`, retention) is unchanged.

2. **Built-in templates + lazy seeding.** A static `BASE_TEMPLATES` registry maps a language to `{ setupCommands, lockfiles[] }`:
   - `js` — `FROM` stock (already ships node + yarn) + enable pnpm via `corepack enable`.
   - `python` — `apt-get install python3 python3-pip build-essential` + install `uv`.
   - `rust` — `rustup` non-interactive (`--profile minimal`) + symlink `~/.cargo/bin/*` into `/usr/local/bin` so cargo is on the default PATH (the exact recipe validated in the reconcile dogfood).
   `ensureRepoSource` detects the repo's language, calls `ensureBase(orgId, language)` — which creates the base from the template and kicks its bake if the org has no base with that template yet — then parents the repo source to it. Bases appear on first need; an admin can edit a seeded base's `setupCommands` afterward (it is an ordinary base source, template tag retained).

3. **Base selection precedence (per repo).** Highest wins:
   1. `.valet/prebuild.yaml` `image:` — an explicit raw image ref (existing `PrebuildOverride.image`).
   2. `.valet/prebuild.yaml` `base:` — NEW optional field naming a base (built-in template name like `rust`, or a custom base's name); resolves to that org base source.
   3. Admin per-repo override — the repo source's `parentId`, set from the settings UI.
   4. **Auto-detect** — language from lockfiles → the org's base for that language (lazy-seeded per decision 2).
   5. Fallback — stock image (clone only, no install step), today's behavior.

4. **Language detection (one stack, Heroku-style).** A pure `detectLanguage(lockfiles: string[]) → Language | null` maps the repo's root lockfiles to at most one language by a FIXED priority (documented, deterministic): `rust` (`Cargo.lock`) → `python` (`uv.lock` | `requirements.txt` | `pyproject.toml`) → `js` (`pnpm-lock.yaml` | `package-lock.json` | `yarn.lock`). A polyglot repo resolves to the first match by that priority; the override or `.valet/prebuild.yaml base:` handles the exception (a power user points at a custom multi-toolchain base). No match → `null` → stock fallback. `go` and other matrix entries are NOT given built-in bases this pass (they still auto-detect an install recipe and bake `FROM` stock); adding a `go` template later is a one-line registry addition.

5. **Cache management — retention floor + global ceiling.**
   - *Per-source retention (floor):* keep the newest `N = 2` pushed bakes per source (existing `applyRetention`), so every source always has a usable image plus one rollback.
   - *Global size ceiling:* `VALET_PREBUILD_CACHE_BUDGET_GB` (default `40`). After a bake pushes, if the total size of pushed bake images exceeds the budget, evict oldest bakes — NEVER a source's current (newest pushed) bake, and NEVER a bake referenced by a live session (`agent_sessions.bake_id` of an active/hibernated session). Eviction deletes the registry tag and the `bakes` row. Bake image sizes come from the registry manifest (sum of layer sizes) recorded on the `bakes` row at push time (new nullable `size_bytes` column).
   - *Registry GC:* the bundled `registry-gc` CronJob was erroring — fix it so `registry garbage-collect` actually reclaims blob bytes after tag deletion (deleting a tag/manifest alone frees nothing until GC runs). Retention/ceiling delete tags; GC reclaims the underlying blobs.
   - *BuildKit job cache* stays ephemeral (`emptyDir` context, one buildkitd per job) — no cross-build accumulation. Accepted tradeoff: no cross-bake layer reuse (each bake re-runs its install). Revisit only if bake latency becomes the pain.
   - *Node image store* is handled by kubelet's own image GC (automatic).

6. **The dev api-image fragility is documented, not code-fixed.** On Rancher Desktop the api image is a local-only tag; kubelet image GC under disk pressure can evict it, and with no registry to re-pull from the api goes `ImagePullBackOff` (observed live). This is dev-only (prod pulls from a registry with a normal pull policy). Mitigations: a runbook note in `deploy/README.md`, and a `make prune-build-cache` helper for the local moby build cache (the 64 GB dev-loop accumulation that actually triggered the incident — distinct from the product's registry cache).

## Non-goals

- Composing a single base from multiple toolchains (a "rust+node" base). Polyglot repos use the override or a hand-authored custom base.
- `go`/other-language built-in bases (registry-extensible later).
- Persistent/shared BuildKit layer cache (perf optimization, separate concern).
- Solving the local api-image eviction in code (dev-only; documented).

## Data model changes (pre-1.0, edit `0000_app.sql` + Drizzle in place)

- `image_sources`: DROP index `image_sources_org_base`; ADD `template TEXT` (nullable; CHECK in (`rust`,`python`,`js`) when not null).
- `bakes`: ADD `size_bytes BIGINT` (nullable; set at push from the registry manifest, used by the size ceiling).
- Live-cluster DDL block recorded in the migration commit body (per the reconcile spec's precedent).

## Components (each independently testable)

- `packages/api/src/bakes/base-templates.ts` — `BASE_TEMPLATES` registry + `detectLanguage(lockfiles)`. Pure, unit-golden-tested.
- `SourceService.ensureBase(orgId, language)` — idempotent create-from-template-and-bake; `ensureRepoSource` calls it then sets `parentId`.
- `SourceService` base-selection resolver — applies the decision-3 precedence when creating/refreshing a repo source's parent.
- `SourceService.applyRetention` (extend) + new `enforceCacheCeiling` — floor + ceiling; both skip current and live-referenced bakes.
- Recipe override — extend `PrebuildOverride` with `base?: string`; resolution reads it.
- `k8s-builder` / registry-gc chart — fix the GC CronJob; record `size_bytes` at push.
- Web `sources-section.tsx` — bases list (language-badged built-ins + custom + "Add base"); repo rows show resolved base with an override dropdown.

## Exit criteria (the dogfood)

On the local k8s deploy: bind a JS repo → a `js` base lazy-seeds, bakes, the repo bakes `FROM` it. Bind a Rust repo → a separate `rust` base seeds and bakes; the Rust repo `cargo fetch`es against it while the JS base stays lean. Switch a repo's base in the UI → next bake uses the chosen base. A `.valet/prebuild.yaml` with `base: python` overrides detection. Drive bakes past the size budget → oldest non-current, non-live bakes evict and registry GC reclaims the bytes; a source's current bake and a live session's bake are never evicted. Two consecutive nightly passes with no changes → no rebakes, no evictions.

## Testing

- **Templates/detection unit:** `detectLanguage` priority matrix (single, polyglot→first-by-priority, none→null); template registry shape; setup-command STE/newline validity (reuses the write-boundary guard).
- **Lazy seed:** `ensureRepoSource` on a rust repo with no rust base → creates a `rust`-template base, bakes it, parents the repo; second rust repo reuses the same base (no duplicate).
- **Precedence:** yaml `image` > yaml `base` > admin override (`parentId`) > detect > stock — one test per rung, plus the full ladder.
- **Cache:** retention floor keeps N=2; ceiling evicts oldest over budget; NEVER evicts a source's current bake or a live-session-referenced bake; `size_bytes` recorded at push; registry GC reclaim asserted (cluster-gated).
- **Chart:** registry-gc CronJob golden (fixed command); `VALET_PREBUILD_CACHE_BUDGET_GB` plumbed.
- **Live (exit criteria):** the JS+Rust dual-base flow end to end.
