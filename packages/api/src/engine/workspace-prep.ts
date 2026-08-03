/**
 * Sandbox prep: clone bound repos via the credential helper (GitHub/repo
 * integration plan, Task 9). `buildWorkspacePrep` returns the closure wired
 * as `prepareSandbox` on `CreateSessionOptions` (engine seam, Task 1) — it
 * runs once per (sandbox, epoch) after a freshly cold-booted sandbox reports
 * ready and BEFORE any waiter observes it.
 *
 * ── Sequence ───────────────────────────────────────────────────────────
 *   1. Install `git-credential-valet` + `valet-gh` (Task 8's script
 *      generators, written verbatim — no token material embedded) and wire
 *      git to use the helper. HARD PREREQUISITE (Task 8 review): git does
 *      NOT send `path=` to credential helpers by default, and the helper
 *      derives `owner` from it, so `credential.useHttpPath` MUST be set or
 *      every clone runs anonymous.
 *   2. Set `user.name`/`user.email` (sandbox-global git config) from the
 *      session owner's profile, falling back to a generic identity.
 *   3. Per binding, in position order: an existing clone (`.git` present)
 *      gets a best-effort `fetch`/`checkout` — failures are logged and
 *      prep continues (offline-tolerant); otherwise a fresh `git clone`,
 *      whose failure THROWS (prep fails → startup-failure semantics, per
 *      the engine seam's contract).
 *
 * ── Path discipline (relative-only) ───────────────────────────────────────
 * Every `readFile`/`writeFile`/`exec` call this module makes uses a path
 * RELATIVE to the sandbox's default cwd (which every `Sandbox` provider
 * defines as the session workspace root) or, for the credential scripts,
 * a plain absolute in-container path used only inside an `exec` command
 * string. This is deliberate, not stylistic: `Sandbox.writeFile`'s
 * "absolute path" branch resolves differently per backend — for
 * `sandbox-docker` an absolute path outside the bind-mounted workspace
 * (e.g. `/usr/local/bin/...`) resolves against the HOST filesystem (broken:
 * writes to the host machine, not the container, and usually EACCES),
 * while `sandbox-local` treats it as a literal host path by design (no
 * isolation). Relative paths are the one contract every backend honors
 * identically. So the credential scripts are staged at a workspace-relative
 * path via `writeFile`, then moved into place via `exec` (which really
 * does execute inside the sandbox's own filesystem/container for every
 * backend) — never `writeFile`ed directly to `/usr/local/bin`.
 *
 * ── Token discipline ───────────────────────────────────────────────────
 * No token material ever appears in an exec argv or written file: the
 * credential helper resolves auth out-of-band via
 * `POST /api/sandbox/git-credential` at clone time. This module only ever
 * interpolates non-secret values (`apiUrl`, repo URLs/paths, git identity).
 */
import type { ExecResult, Sandbox, SessionStartRef } from "@valet/engine";
import { gitCredentialHelperScript, ghWrapperScript } from "./git-credential-helper.js";
import { ownerOf } from "../services/session-github-token.js";
import { PREBUILT_REPO_PATH, type RecipeStep } from "../prebuilds/recipe.js";
import type { RepoBinding } from "../wire/types.js";

/** Workspace-relative staging dir the two scripts are written to (via
 * `Sandbox.writeFile`, which only reliably targets workspace-relative
 * paths — see the file header) before `exec` moves them into place. */
const STAGING_DIR = ".valet-prep";

/** Final, real in-sandbox locations — referenced only inside `exec`
 * command strings, never passed to `writeFile` directly. */
const HELPER_PATH = "/usr/local/bin/git-credential-valet";
const GH_WRAPPER_PATH = "/usr/local/bin/valet-gh";
/** The same wrapper script ALSO installs as `gh` itself — /usr/local/bin
 * precedes /usr/bin on PATH, so a plain `gh` transparently authenticates.
 * The script locates the real binary by skipping /usr/local/bin. */
const GH_SHIM_PATH = "/usr/local/bin/gh";

const DEFAULT_USER_NAME = "Valet Agent";
const DEFAULT_USER_EMAIL = "agent@valet.local";


/** POSIX single-quote escaping for values interpolated into `sh` command
 * strings passed to `Sandbox.exec`. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function posixJoin(a: string, b: string): string {
  return `${a.replace(/\/+$/, "")}/${b}`;
}

/** `owner/repo` → `repo` (the segment after the first "/"; the whole
 * string when there is no "/"). */
function repoNameOf(fullName: string): string {
  const idx = fullName.indexOf("/");
  return idx === -1 ? fullName : fullName.slice(idx + 1);
}

/** Disambiguated dir name for a colliding binding: `<owner>__<repo>` (falls
 * back to the bare repo name when there's no owner segment to prefix). Uses
 * `__` rather than `/` so it stays a single flat subdir under the workspace
 * root. */
function disambiguatedDirOf(fullName: string): string {
  const owner = ownerOf(fullName);
  const repo = repoNameOf(fullName);
  return owner ? `${owner}__${repo}` : repo;
}

/**
 * Workspace-relative target clone dir for every binding, in position order.
 * Every binding gets its own subdir named for its repo (`<repoName>`) —
 * EXCEPT when two or more bindings share a repo name (`acme/widgets` +
 * `beta/widgets` both → `widgets`), which would silently make the second clone
 * target the first's dir (fetch the wrong remote). Every binding in a colliding
 * group is disambiguated to `<owner>__<repo>` deterministically; non-colliding
 * bindings keep the plain `<repo>` name.
 *
 * Spec decision 15: single-repo sessions always clone into `<repo>/`, never
 * into the workspace root `.`. This is the NEW behavior for sessions created
 * after this change; sessions with `target_dir NULL` keep the old layout via
 * `legacyTargetDirs` in session-meta.ts.
 *
 * Exported for direct unit coverage of the collision layout and for bind-time
 * persistence in the session-create route.
 */
export function computeTargetDirs(repos: RepoBinding[]): string[] {
  const nameCounts = new Map<string, number>();
  for (const r of repos) {
    const name = repoNameOf(r.fullName);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  return repos.map((r) => {
    const name = repoNameOf(r.fullName);
    return (nameCounts.get(name) ?? 0) > 1 ? disambiguatedDirOf(r.fullName) : name;
  });
}

/** Runs `sandbox.exec`, converting a rejection into a synthetic failed
 * `ExecResult` so callers can treat "exec threw" and "exec returned
 * non-zero" uniformly. */
async function safeExec(sandbox: Sandbox, command: string, opts?: { cwd?: string }): Promise<ExecResult> {
  try {
    return await sandbox.exec(command, opts);
  } catch (err) {
    return { stdout: "", stderr: err instanceof Error ? err.message : String(err), exitCode: 1 };
  }
}

function execFailureMessage(label: string, result: ExecResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail ? `${label}: ${detail}` : label;
}

/** Stages the two Task 8 scripts at a workspace-relative path (via
 * `writeFile`), then `exec`s them into `/usr/local/bin` with mode 755 and
 * wires git to use the helper for every host (`credential.helper` + the
 * hard prerequisite `credential.useHttpPath`). Throws on any failure — an
 * unconfigured sandbox can't authenticate any clone below. */
export async function installCredentialHelper(sandbox: Sandbox, apiUrl: string): Promise<void> {
  await sandbox.mkdir(STAGING_DIR);
  const stagedHelper = posixJoin(STAGING_DIR, "git-credential-valet");
  const stagedGhWrapper = posixJoin(STAGING_DIR, "valet-gh");
  await sandbox.writeFile(stagedHelper, gitCredentialHelperScript(apiUrl));
  await sandbox.writeFile(stagedGhWrapper, ghWrapperScript(apiUrl));

  const install = await sandbox.exec(
    [
      "mkdir -p /usr/local/bin",
      `cp ${shQuote(stagedHelper)} ${HELPER_PATH}`,
      `cp ${shQuote(stagedGhWrapper)} ${GH_WRAPPER_PATH}`,
      `cp ${shQuote(stagedGhWrapper)} ${GH_SHIM_PATH}`,
      `chmod 755 ${HELPER_PATH} ${GH_WRAPPER_PATH} ${GH_SHIM_PATH}`,
    ].join(" && "),
  );
  if (install.exitCode !== 0) {
    throw new Error(execFailureMessage("workspace prep: installing credential helper failed", install));
  }
  // Best-effort cleanup of the staging dir — never fatal.
  await safeExec(sandbox, `rm -rf ${shQuote(STAGING_DIR)}`);

  const helperConfig = await sandbox.exec(`git config --global credential.helper ${shQuote(HELPER_PATH)}`);
  if (helperConfig.exitCode !== 0) {
    throw new Error(execFailureMessage("workspace prep: git config credential.helper failed", helperConfig));
  }

  // HARD PREREQUISITE (Task 8 review): without this, git never sends
  // `path=` to the helper and every clone runs anonymous.
  const useHttpPath = await sandbox.exec("git config --global credential.useHttpPath true");
  if (useHttpPath.exitCode !== 0) {
    throw new Error(execFailureMessage("workspace prep: git config credential.useHttpPath failed", useHttpPath));
  }

  // Discovered running this against a real Docker sandbox (docker-gated
  // integration test): the workspace bind-mount is owned by the HOST
  // user's uid, but `git` runs as whatever uid `docker exec` defaults to
  // (root in a stock image) — a uid mismatch git treats as "dubious
  // ownership" and refuses to operate on (`fatal: detected dubious
  // ownership in repository at '/workspace'`), which would otherwise
  // silently brick every clone/fetch/checkout below. `*` covers every
  // binding's target dir regardless of layout.
  const safeDirectory = await sandbox.exec("git config --global --add safe.directory '*'");
  if (safeDirectory.exitCode !== 0) {
    throw new Error(execFailureMessage("workspace prep: git config safe.directory failed", safeDirectory));
  }
}

export async function configureGitIdentity(sandbox: Sandbox, userName?: string, userEmail?: string): Promise<void> {
  const name = userName?.trim() || DEFAULT_USER_NAME;
  const email = userEmail?.trim() || DEFAULT_USER_EMAIL;

  const nameResult = await sandbox.exec(`git config --global user.name ${shQuote(name)}`);
  if (nameResult.exitCode !== 0) {
    throw new Error(execFailureMessage("workspace prep: git config user.name failed", nameResult));
  }
  const emailResult = await sandbox.exec(`git config --global user.email ${shQuote(email)}`);
  if (emailResult.exitCode !== 0) {
    throw new Error(execFailureMessage("workspace prep: git config user.email failed", emailResult));
  }
}

/** True when `<dir>/.git` exists (file or directory — a worktree's `.git`
 * is a file), i.e. `dir` already holds a clone. `dir` is workspace-relative
 * (`.` or a subdir name). */
async function dirHasGit(sandbox: Sandbox, dir: string): Promise<boolean> {
  try {
    const st = await sandbox.stat(posixJoin(dir, ".git"));
    return st.isDirectory || st.isFile;
  } catch {
    return false;
  }
}

/** `git clone` requires an empty (or non-existent) target directory.
 * Session create pre-creates the workspace root, so the single-binding
 * case clones into an existing-but-empty dir — fine. A non-empty dir with
 * no `.git` is an unrecoverable prep state; throw with a clear message
 * rather than silently clobbering or nesting. */
async function assertCloneTargetEmpty(sandbox: Sandbox, dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await sandbox.readdir(dir);
  } catch {
    return; // doesn't exist yet — git clone will create it.
  }
  if (entries.length > 0) {
    throw new Error(`workspace prep: clone target ${dir} exists and is not empty (no .git present)`);
  }
}

/** Best-effort refresh of an already-cloned dir: `git fetch origin`, then
 * `git checkout {ref}` when a ref is pinned. Offline-tolerant — failures
 * are logged and prep continues to the next binding, never thrown. */
async function refreshExistingClone(sandbox: Sandbox, dir: string, binding: RepoBinding): Promise<void> {
  const fetch = await safeExec(sandbox, "git fetch origin", { cwd: dir });
  if (fetch.exitCode !== 0) {
    console.error(
      `workspace prep: git fetch origin failed for ${binding.fullName} (${dir}) — continuing: ${fetch.stderr || fetch.stdout}`,
    );
  }
  if (binding.ref) {
    const checkout = await safeExec(sandbox, `git checkout ${shQuote(binding.ref)}`, { cwd: dir });
    if (checkout.exitCode !== 0) {
      console.error(
        `workspace prep: git checkout ${binding.ref} failed for ${binding.fullName} (${dir}) — continuing: ${checkout.stderr || checkout.stdout}`,
      );
    }
  }
}

/** Resolves the remote's default branch name from `refs/remotes/origin/HEAD`
 * (set by the bake clone, and preserved through `cp -a`). Returns e.g. `main`
 * for `refs/remotes/origin/main`, or `null` when the symbolic ref is absent /
 * unparseable (e.g. a bare remote with no HEAD) — the caller then leaves the
 * staged tree at the baked commit rather than guessing a branch. */
async function resolveRemoteDefaultBranch(sandbox: Sandbox, dir: string): Promise<string | null> {
  const res = await safeExec(sandbox, "git symbolic-ref refs/remotes/origin/HEAD", { cwd: dir });
  if (res.exitCode !== 0) return null;
  const prefix = "refs/remotes/origin/";
  const ref = res.stdout.trim();
  if (!ref.startsWith(prefix)) return null;
  const branch = ref.slice(prefix.length);
  return branch.length > 0 ? branch : null;
}

/**
 * Advances a FRESHLY-STAGED prebuilt repo (just `cp -a`'d out of the image, so
 * HEAD *and* the baked local branch both sit at `bakedSha`) to upstream head.
 *
 * `git fetch origin` then `git checkout -B <ref> origin/<ref>`. The `-B` is
 * load-bearing (spec decision 7): a plain `git checkout <ref>` would land on
 * the STALE LOCAL branch the bake left at `bakedSha` — git does NOT
 * fast-forward an already-existing branch on checkout — so the workspace would
 * never reach upstream head and `conditionalReinstall`'s `bakedSha..HEAD` diff
 * would always be empty (the reinstall trigger dead in the common path). `-B`
 * resets the local branch to origin's just-fetched head, actually moving the
 * tree forward. When no ref is pinned, the remote's default branch (from
 * `origin/HEAD`) is used.
 *
 * Returns whether the fetch SUCCEEDED: `false` on an offline fetch, so the
 * caller skips the conditional reinstall entirely — the tree never left
 * `bakedSha`, exactly the baked state, and re-running installs against an
 * unchanged lockfile would be pointless work. Offline-tolerant throughout:
 * every failure is logged, none thrown (a prebuild is an optimization, never a
 * correctness dependency). This path is ONLY for the freshly-staged case;
 * warm restores keep the in-place `refreshExistingClone` behavior.
 */
async function refreshStagedPrebuild(sandbox: Sandbox, dir: string, binding: RepoBinding): Promise<boolean> {
  const fetch = await safeExec(sandbox, "git fetch origin", { cwd: dir });
  if (fetch.exitCode !== 0) {
    console.error(
      `workspace prep: git fetch origin failed for ${binding.fullName} (${dir}) — staying at the baked commit, skipping reinstall: ${fetch.stderr || fetch.stdout}`,
    );
    return false;
  }
  const ref = binding.ref ?? (await resolveRemoteDefaultBranch(sandbox, dir));
  if (!ref) {
    console.error(
      `workspace prep: could not resolve a remote default branch for ${binding.fullName} (${dir}) — staying at the baked commit`,
    );
    return true;
  }
  const checkout = await safeExec(sandbox, `git checkout -B ${shQuote(ref)} ${shQuote(`origin/${ref}`)}`, { cwd: dir });
  if (checkout.exitCode !== 0) {
    console.error(
      `workspace prep: git checkout -B ${ref} origin/${ref} failed for ${binding.fullName} (${dir}) — continuing: ${checkout.stderr || checkout.stdout}`,
    );
  }
  return true;
}

/** Fresh clone into `dir` (workspace-relative). Failure THROWS — this is
 * the "prep fails → startup-failure" path (engine seam, Task 1). */
async function cloneFresh(sandbox: Sandbox, dir: string, binding: RepoBinding): Promise<void> {
  await assertCloneTargetEmpty(sandbox, dir);

  const parts = [`git clone ${shQuote(binding.cloneUrl)} ${shQuote(dir)}`];
  if (binding.ref) parts.push(`--branch ${shQuote(binding.ref)}`);
  const command = parts.join(" ");

  const result = await safeExec(sandbox, command);
  if (result.exitCode !== 0) {
    throw new Error(execFailureMessage(`workspace prep: git clone failed for ${binding.fullName}`, result));
  }
}

export async function prepBinding(sandbox: Sandbox, dir: string, binding: RepoBinding): Promise<void> {
  const hasGit = await dirHasGit(sandbox, dir);
  if (hasGit) {
    await refreshExistingClone(sandbox, dir, binding);
    return;
  }
  await cloneFresh(sandbox, dir, binding);
}

/**
 * Stages the baked repo out of the prebuilt image into `dir` with `cp -a`.
 * `cp -a` (archive: recursive, preserve, no-deref) copies EVERYTHING under
 * `PREBUILT_REPO_PATH` — `.git`, the checked-out tree, AND the untracked
 * `node_modules`/`.venv`/etc. the baked install steps produced. A local
 * `git clone <path>` would copy only tracked git objects and silently drop
 * those install artifacts, defeating the whole point of the prebuild. Failure
 * THROWS — without the staged repo there's nothing to refresh (startup-failure
 * semantics, engine seam Task 1). `dir` is workspace-relative; `mkdir -p`
 * first so a multi-binding subdir (which git-clone would otherwise create)
 * exists before the copy.
 */
async function stagePrebuiltRepo(sandbox: Sandbox, dir: string): Promise<void> {
  const q = shQuote(dir);
  const result = await safeExec(sandbox, `mkdir -p ${q} && cp -a ${PREBUILT_REPO_PATH}/. ${q}`);
  if (result.exitCode !== 0) {
    throw new Error(execFailureMessage(`workspace prep: staging prebuilt repo into ${dir} failed`, result));
  }
}

/**
 * Re-runs each recipe step whose lockfile drifted between the image's baked
 * commit and the fetched head. `git diff --name-only <bakedSha> HEAD -- <lock>`
 * naming the lockfile (or the diff command erroring — treated conservatively
 * as "changed" so stale deps never ship silently) triggers the step. Offline
 * with head still at `bakedSha` → empty diff → every step skipped (the cheap
 * path). A reinstall failure is logged and tolerated, not thrown: the COLD
 * path (no prebuild) never runs installs at all, so a prebuild is strictly an
 * optimization — it must never make a session LESS available than cold boot.
 * The agent hands over with baked/partial deps and can fix them itself,
 * exactly as it would on a cold session.
 */
async function conditionalReinstall(
  sandbox: Sandbox,
  dir: string,
  prebuild: { bakedSha: string; recipe: RecipeStep[] },
): Promise<void> {
  for (const step of prebuild.recipe) {
    const diff = await safeExec(
      sandbox,
      `git diff --name-only ${shQuote(prebuild.bakedSha)} HEAD -- ${shQuote(step.lockfile)}`,
      { cwd: dir },
    );
    const changed = diff.exitCode !== 0 || diff.stdout.trim() !== "";
    if (!changed) continue;
    const install = await safeExec(sandbox, step.command, { cwd: dir });
    if (install.exitCode !== 0) {
      // Degrade, don't throw: prebuilds are an optimization, never a
      // correctness dependency. The COLD path never runs installs at all, so
      // throwing here would make enabling a prebuild strictly worse than not
      // having one — bricking the session on every restore (the reinstall
      // re-runs against the same drifted lockfile each time). Hand over with
      // baked/partial deps; the agent can fix dependencies itself.
      console.error(
        execFailureMessage(`workspace prep: prebuild reinstall '${step.command}' (${step.lockfile}) failed`, install),
      );
    }
  }
}

/**
 * Prep for the PRIMARY binding when the session booted from a prebuilt image.
 * A persistent workspace that already holds the repo (`.git` present — restore
 * / warm PVC) takes the SAME offline-tolerant refresh path as any existing
 * clone; the baked image is irrelevant then (the workspace copy is
 * authoritative). Otherwise (cold workspace): stage the baked repo out of the
 * image, reset `origin` to the real clone url, fetch + `checkout -B` the target
 * ref off origin's head (`refreshStagedPrebuild` — moves the tree PAST the
 * baked commit, unlike a plain checkout of the stale baked local branch), then
 * conditionally re-run drifted installs — but ONLY when the fetch succeeded (an
 * offline fetch leaves HEAD at `bakedSha`, so there is nothing to reinstall).
 */
export async function prepPrebuiltBinding(
  sandbox: Sandbox,
  dir: string,
  binding: RepoBinding,
  prebuild: { bakedSha: string; recipe: RecipeStep[] },
): Promise<void> {
  const hasGit = await dirHasGit(sandbox, dir);
  if (hasGit) {
    await refreshExistingClone(sandbox, dir, binding);
    return;
  }
  await stagePrebuiltRepo(sandbox, dir);
  // The baked clone's `origin` already points at `cloneUrl` (the Dockerfile
  // cloned it), but reset it explicitly — non-secret url only — so a renamed
  // remote can't leave the fetch below pointed at the wrong place. Best-effort:
  // a failure here is logged, not fatal (the fetch would fail loudly anyway).
  const setUrl = await safeExec(sandbox, `git remote set-url origin ${shQuote(binding.cloneUrl)}`, { cwd: dir });
  if (setUrl.exitCode !== 0) {
    console.error(
      `workspace prep: git remote set-url origin failed for ${binding.fullName} (${dir}) — continuing: ${setUrl.stderr || setUrl.stdout}`,
    );
  }
  const fetched = await refreshStagedPrebuild(sandbox, dir, binding);
  if (fetched) await conditionalReinstall(sandbox, dir, prebuild);
}

/**
 * Resolve the PRIMARY binding's start-ref from the prepped clone (engine
 * traces spec, change 2): origin URL, full HEAD SHA, and the checked-out
 * branch (`undefined` when detached). Returns null when any piece is
 * unresolvable — callers treat that as "no start-ref", never a prep failure.
 * Exported for direct unit coverage.
 */
export async function resolveStartRef(sandbox: Sandbox, dir: string): Promise<SessionStartRef | null> {
  const res = await safeExec(
    sandbox,
    "git remote get-url origin && git rev-parse HEAD && git rev-parse --abbrev-ref HEAD",
    { cwd: dir },
  );
  if (res.exitCode !== 0) return null;
  const [repoUrl, commitSha, branch] = res.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim());
  if (!repoUrl || !commitSha) return null;
  return {
    repoUrl,
    commitSha,
    // `--abbrev-ref HEAD` prints literally "HEAD" for detached checkouts.
    branch: branch && branch !== "HEAD" ? branch : undefined,
    capturedAt: Date.now(),
  };
}

