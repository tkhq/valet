/**
 * File checkpoints in the sandbox's git repositories and loose workspace files
 * (docs/specs/2026-10-22-thread-edit-fork-design.md, "File checkpoints").
 *
 * A turn that runs a tool marked `sideEffect: "files"` snapshots each git
 * repository under the working directory before the first such call, and
 * again when the turn ends. A snapshot is a commit of the whole working tree
 * (tracked and untracked files, not ignored ones) written through a
 * temporary index, so the person's staging area and files never change. The
 * commits live under `refs/valet/checkpoints/`, which keeps them from git's
 * garbage collection for the life of the repository.
 *
 * An edit can undo the file changes of the turns it replaces. The undo
 * touches only the paths those turns changed, and skips a path whose content
 * changed after them, because a personal assistant's threads share one
 * sandbox.
 */
import { readBranchNote, type BranchNoteRepoFiles } from "./branch-note.js";
import type { Sandbox, SessionEntry } from "./types.js";

/** User-entry metadata key for the turn's checkpoint record. */
export const FILE_CHECKPOINT_KEY = "fileCheckpoint";

/** Untracked files larger than this in total stay out of a snapshot. */
const MAX_UNTRACKED_KB = 50 * 1024;
/** A snapshot that takes longer than this is skipped, so a turn never waits on it. */
const SNAPSHOT_TIMEOUT_MS = 20_000;
const RESTORE_TIMEOUT_MS = 30_000;
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Valet",
  GIT_AUTHOR_EMAIL: "checkpoint@valet.invalid",
  GIT_COMMITTER_NAME: "Valet",
  GIT_COMMITTER_EMAIL: "checkpoint@valet.invalid",
};

/** Reserved checkpoint target; it is not a repository in the workspace. */
export const WORKSPACE_FILES = "@workspace-files";
const WORKSPACE_STORE = ".valet-file-checkpoints";

// Commands use relative paths under cwd: Sandbox maps cwd and file IO, but
// does not rewrite paths embedded in shell commands. Never init the workspace.
const WORKSPACE_GIT = `git() { command git --git-dir=${WORKSPACE_STORE} --work-tree=. "$@"; }
`;

/** Bounded, regular-file-only coverage. Hidden paths (including credentials,
 * engine metadata and .git), dependencies, caches and build output are omitted.
 * Repositories at ANY depth are pruned, even beyond findRepos' discovery bound.
 * This intentionally does not promise rollback of all sandbox state. */
const WORKSPACE_EXCLUDED_NAMES = [
  ".*", "node_modules", "vendor", "__pycache__", "dist", "build", "target", "coverage",
  "secrets", "credentials", "*.pem", "*.key", "*.p12", "*.pfx", "*credentials*", "*secret*",
];
const WORKSPACE_FILES_SCRIPT = `find . \\( \\( ! -name . \\( ${WORKSPACE_EXCLUDED_NAMES.map((name) => `-name ${q(name)}`).join(" -o ")} \\) \\) -o \\( -type d \\( -exec test -e '{}/.git' \\; -o \\( -exec test -f '{}/HEAD' \\; -exec test -d '{}/objects' \\; \\) \\) \\) \\) -prune -o -type f -print0`;

const WORKSPACE_SNAPSHOT = `set -e
[ ! -L ${WORKSPACE_STORE} ] || exit 1
initialize=
if [ ! -d ${WORKSPACE_STORE} ]; then
  [ ! -e .git ] && [ ! -L .git ] || exit 1
  [ ! -f HEAD ] || [ ! -d objects ] || exit 1
  mkdir -p ${WORKSPACE_STORE}
  initialize=1
fi
# Protect the entire service-owned store, including this ignore file, from
# ordinary git add if a tool later initializes the working directory.
[ ! -L ${WORKSPACE_STORE}/.gitignore ] || exit 1
[ ! -e ${WORKSPACE_STORE}/.gitignore ] || [ -f ${WORKSPACE_STORE}/.gitignore ] || exit 1
if [ "$(cat ${WORKSPACE_STORE}/.gitignore 2>/dev/null || true)" != '*' ]; then
  ignore=$(mktemp ${WORKSPACE_STORE}/.gitignore.XXXXXX)
  printf '*\\n' > "$ignore"
  mv -f "$ignore" ${WORKSPACE_STORE}/.gitignore
fi
if [ -n "$initialize" ]; then command git init --bare -q ${WORKSPACE_STORE}; fi
${WORKSPACE_GIT}
idx=$(mktemp)
list=$(mktemp)
trap 'rm -f "$idx" "$list"' EXIT
rm -f "$idx"
export GIT_INDEX_FILE="$idx"
git read-tree --empty
${WORKSPACE_FILES_SCRIPT} > "$list"
kb=0
if [ -s "$list" ]; then kb=$(xargs -0 du -k < "$list" | awk '{s+=$1} END {print s+0}'); fi
# Refuse the whole snapshot rather than treat excluded files as deletions.
[ "$kb" -le "$VALET_MAX_UNTRACKED_KB" ] || exit 1
git --literal-pathspecs add -f --pathspec-from-file="$list" --pathspec-file-nul
tree=$(git write-tree)
commit=$(git commit-tree "$tree" -m 'valet workspace checkpoint')
git update-ref "$VALET_REF" "$commit"
empty=
[ -s "$list" ] || empty=1
printf '%s\\n\\n\\n%s\\n' "$commit" "$empty"`;

// Restore/seed paths must still be eligible NOW. In particular a directory
// converted to a repository, or replaced by a symlink, must be left alone.
const WORKSPACE_SAFE_PATH = `safe_path() {
  case "$1" in ''|/*|../*|*/../*|*/..|./*|*//*) return 1;; esac
  rest="$1"; prefix=.
  [ ! -e .git ] && [ ! -L .git ] || return 1
  [ ! -f HEAD ] || [ ! -d objects ] || return 1
  while [ -n "$rest" ]; do
    part=\${rest%%/*}
    case "$part" in ${WORKSPACE_EXCLUDED_NAMES.join("|")}) return 1;; esac
    prefix="$prefix/$part"
    [ ! -L "$prefix" ] && [ ! -e "$prefix/.git" ] && [ ! -L "$prefix/.git" ] || return 1
    [ ! -f "$prefix/HEAD" ] || [ ! -d "$prefix/objects" ] || return 1
    case "$rest" in */*) rest=\${rest#*/};; *) rest=;; esac
  done
}
`;

/** One repository's change in one turn. */
export interface RepoCheckpoint {
  /**
   * The repository's root relative to the working directory ("." for the
   * working directory itself). Commands reach it through `cwd`, which every
   * sandbox maps; a path inside a command would not be mapped.
   */
  repo: string;
  /** Snapshot commit before the turn's first file change. */
  before: string;
  /** Snapshot commit when the turn ended. */
  after: string;
  /** Repo-relative paths that differ between `before` and `after`. */
  changed: string[];
  /** Paths whose actual tool-write receipt chain matches both snapshots. Missing on legacy records. */
  authoredPaths?: string[];
  /** Branch checked out when the turn ended, if any. */
  branch?: string;
  /** Untracked files were over the size limit, so the snapshots hold tracked files only. */
  partial?: boolean;
  /** This repository was created during the turn, after its baseline snapshot. */
  undoUnavailable?: string;
}

export interface TurnCheckpoint {
  repos: RepoCheckpoint[];
  /** Targets with unavailable coverage; never imply that these files were restored. */
  unavailable?: Array<{ repo: string; reason: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readTurnCheckpoint(metadata: Record<string, unknown> | undefined): TurnCheckpoint | undefined {
  const value = metadata?.[FILE_CHECKPOINT_KEY];
  if (!isRecord(value) || !Array.isArray(value.repos)) return undefined;
  const repos = value.repos.flatMap((r: unknown): RepoCheckpoint[] => {
    if (!isRecord(r)) return [];
    if (typeof r.repo !== "string" || typeof r.before !== "string" || typeof r.after !== "string" || !Array.isArray(r.changed)) return [];
    return [{
      repo: r.repo,
      before: r.before,
      after: r.after,
      changed: r.changed.filter((path): path is string => typeof path === "string"),
      ...(Array.isArray(r.authoredPaths) ? { authoredPaths: r.authoredPaths.filter((path): path is string => typeof path === "string") } : {}),
      ...(typeof r.branch === "string" ? { branch: r.branch } : {}),
      ...(r.partial === true ? { partial: true } : {}),
      ...(typeof r.undoUnavailable === "string" ? { undoUnavailable: r.undoUnavailable } : {}),
    }];
  });
  const unavailable = Array.isArray(value.unavailable) ? value.unavailable.flatMap((item: unknown) =>
    isRecord(item) && typeof item.repo === "string" && typeof item.reason === "string"
      ? [{ repo: item.repo, reason: item.reason }] : []) : [];
  return { repos, ...(unavailable.length > 0 ? { unavailable } : {}) };
}

export function checkpointRef(threadId: string, entryId: string, label: string): string {
  return `refs/valet/checkpoints/${threadId}/${entryId}/${label}`;
}

/** Quote one value for a POSIX shell. */
function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A repository's directory: `repo` (relative) under the working directory. */
export function repoDir(workspace: string, repo: string): string {
  const root = workspace.replace(/\/+$/, "");
  return repo === "." || repo === WORKSPACE_FILES ? root : `${root}/${repo}`;
}

/** The git repositories at most three levels under the working directory, relative to it. */
export async function findRepos(sandbox: Sandbox, workspace: string): Promise<string[]> {
  const result = await sandbox.exec(
    "find . -maxdepth 3 -name .git -not -path '*/node_modules/*' -print 2>/dev/null",
    { cwd: workspace, timeout: SNAPSHOT_TIMEOUT_MS },
  );
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
    .map((gitPath) => gitPath.replace(/\/?\.git$/, "").replace(/^\.\//, "") || ".").sort();
}

const SNAPSHOT_SCRIPT = `set -e
gitdir=$(git rev-parse --git-dir)
idx=$(mktemp)
trap 'rm -f "$idx"' EXIT
# Keep the index file's time (cp -p): git rehashes entries whose files
# changed in the same second as the index was written ("racy git"), and a
# fresh copy time would hide them.
if [ -f "$gitdir/index" ]; then cp -p "$gitdir/index" "$idx"; else rm -f "$idx"; fi
partial=
if [ -n "$(git ls-files -o --exclude-standard --exclude=.valet-file-checkpoints/ | head -n 1)" ]; then
  kb=$(git ls-files -o --exclude-standard --exclude=.valet-file-checkpoints/ -z | xargs -0 du -k 2>/dev/null | awk '{s+=$1} END {print s+0}')
  if [ "$kb" -gt "$VALET_MAX_UNTRACKED_KB" ]; then partial=1; fi
fi
if [ -n "$partial" ]; then GIT_INDEX_FILE="$idx" git add -u -- . ":(exclude).valet-file-checkpoints" ":(glob,exclude)**/.valet-file-checkpoints/**"; else GIT_INDEX_FILE="$idx" git add -A -- . ":(exclude).valet-file-checkpoints" ":(glob,exclude)**/.valet-file-checkpoints/**"; fi
# A person may have staged the metadata after initializing a repository.
# Remove it from OUR copied index as well as excluding it from git add.
GIT_INDEX_FILE="$idx" git rm -r --cached --ignore-unmatch -q -- .valet-file-checkpoints ':(glob)**/.valet-file-checkpoints/**'
tree=$(GIT_INDEX_FILE="$idx" git write-tree)
if parent=$(git rev-parse -q --verify HEAD); then
  commit=$(git commit-tree "$tree" -p "$parent" -m "valet checkpoint")
else
  commit=$(git commit-tree "$tree" -m "valet checkpoint")
fi
git update-ref "$VALET_REF" "$commit"
branch=$(git symbolic-ref -q --short HEAD || true)
printf '%s\\n%s\\n%s\\n' "$commit" "$branch" "$partial"`;

export interface Snapshot {
  commit: string;
  branch?: string;
  partial: boolean;
  /** No eligible files in a workspace overlay. */
  empty?: boolean;
}

/** Commit the repository's whole working tree under `ref`, without touching its index or files. */
export async function snapshotRepo(sandbox: Sandbox, dir: string, ref: string, workspaceFiles = false): Promise<Snapshot> {
  return takeSnapshot(sandbox.exec.bind(sandbox), dir, ref, workspaceFiles);
}

async function takeSnapshot(exec: Sandbox["exec"], dir: string, ref: string, workspaceFiles: boolean): Promise<Snapshot> {
  const result = await exec(workspaceFiles ? WORKSPACE_SNAPSHOT : SNAPSHOT_SCRIPT, {
    cwd: dir,
    timeout: SNAPSHOT_TIMEOUT_MS,
    env: { ...GIT_IDENTITY, VALET_REF: ref, VALET_MAX_UNTRACKED_KB: String(MAX_UNTRACKED_KB) },
  });
  const [commit, branch, partial, empty] = result.stdout.split("\n");
  if (result.exitCode !== 0 || result.timedOut || !commit || !/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new Error(`snapshot of ${dir} failed: ${(result.stderr || result.stdout).trim().slice(0, 300) || "timed out"}`);
  }
  return { commit, ...(branch ? { branch } : {}), partial: partial === "1", ...(empty === "1" ? { empty: true } : {}) };
}

/** Repo-relative paths that differ between two snapshots. */
export async function changedPaths(sandbox: Sandbox, dir: string, before: string, after: string, workspaceFiles = false): Promise<string[]> {
  const result = await sandbox.exec(`${workspaceFiles ? WORKSPACE_GIT : ""}git diff --no-renames --name-only -z ${q(before)} ${q(after)}`, {
    cwd: dir,
    timeout: SNAPSHOT_TIMEOUT_MS,
  });
  if (result.exitCode !== 0 || result.timedOut) throw new Error(`diff in ${dir} failed: ${result.stderr.trim().slice(0, 300)}`);
  return result.stdout.split("\0").filter(Boolean);
}

/**
 * One path to put back: restore it from `source` when its current content
 * still matches `expected`, and skip it otherwise. A path missing from
 * `source` is removed.
 */
export interface PathRestore {
  path: string;
  source: string;
  expected: string;
}

export interface RepoRestore {
  repo: string;
  paths: PathRestore[];
  /** Paths without a verified tool-write chain; never restore across these gaps. */
  skipped?: string[];
  /** Coverage failure, reported without attempting a restore. */
  unavailable?: string;
}

/**
 * The paths an undo of `entries` (the turns an edit replaces) puts back,
 * per repository, from the turns' checkpoint records in order. Each path
 * returns to its content before the first of those turns that changed it,
 * and only while it still holds what the last of them left.
 */
export function planFileUndo(entries: readonly SessionEntry[]): RepoRestore[] {
  const byRepo = new Map<string, Map<string, PathRestore>>();
  const unavailable = new Map<string, string>();
  const skipped = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.role !== "user") continue;
    const checkpoint = readTurnCheckpoint(entry.metadata);
    for (const failed of checkpoint?.unavailable ?? []) unavailable.set(failed.repo, failed.reason);
    for (const repo of checkpoint?.repos ?? []) {
      if (repo.undoUnavailable) unavailable.set(repo.repo, repo.undoUnavailable);
      if (repo.partial) unavailable.set(repo.repo, "A checkpoint pair is partial. Files were left unchanged. Take a complete checkpoint before retrying.");
      const paths = byRepo.get(repo.repo) ?? new Map<string, PathRestore>();
      byRepo.set(repo.repo, paths);
      const unowned = skipped.get(repo.repo) ?? new Set<string>();
      skipped.set(repo.repo, unowned);
      const authored = new Set(repo.authoredPaths ?? []);
      for (const path of repo.changed) {
        if (!authored.has(path)) unowned.add(path);
        // The restore script reads tab-separated lines.
        if (/[\t\n]/.test(path)) continue;
        const known = paths.get(path);
        if (known) known.expected = repo.after;
        else paths.set(path, { path, source: repo.before, expected: repo.after });
      }
    }
  }
  // If any replaced turn lacks coverage, do not restore that target across
  // the gap: expected content alone cannot establish its earlier state.
  return [
    ...[...byRepo].filter(([repo]) => !unavailable.has(repo)).map(([repo, paths]) => {
      const omitted = [...skipped.get(repo) ?? []];
      return { repo, paths: [...paths.values()].filter((path) => !skipped.get(repo)?.has(path.path)),
        ...(omitted.length > 0 ? { skipped: omitted } : {}) };
    }).filter((r) => r.paths.length > 0 || r.skipped?.length),
    ...[...unavailable].map(([repo, reason]) => ({ repo, paths: [], unavailable: reason })),
  ];
}

/**
 * The file plan for "Go back" with files: undo the current version's own
 * changes (`currentUndo`), then put back what a note's undo took away, from
 * its restore point. A path in both returns to the restore point, as long as
 * it still holds what the current version left.
 */
export function returnPlan(currentUndo: readonly RepoRestore[], noteFiles: readonly BranchNoteRepoFiles[]): RepoRestore[] {
  const byRepo = new Map<string, Map<string, PathRestore>>(
    currentUndo.map((repo) => [repo.repo, new Map(repo.paths.map((p) => [p.path, { ...p }]))]),
  );
  for (const files of noteFiles) {
    if (!files.restorePoint || !files.bases) continue;
    const paths = byRepo.get(files.repo) ?? new Map<string, PathRestore>();
    byRepo.set(files.repo, paths);
    for (const [path, base] of Object.entries(files.bases)) {
      paths.set(path, { path, source: files.restorePoint, expected: paths.get(path)?.expected ?? base });
    }
  }
  const skipped = new Map(currentUndo.map((repo) => [repo.repo, repo.skipped ?? []]));
  const unavailable = currentUndo.filter((repo) => repo.unavailable);
  const blocked = new Set(unavailable.map((repo) => repo.repo));
  return [
    ...[...byRepo].filter(([repo]) => !blocked.has(repo)).map(([repo, paths]) => ({
      repo, paths: [...paths.values()].filter((path) => !skipped.get(repo)?.includes(path.path)),
      ...(skipped.get(repo)?.length ? { skipped: skipped.get(repo) } : {}),
    })).filter((r) => r.paths.length > 0 || r.skipped?.length),
    ...unavailable,
  ];
}

/** How many paths a plan touches. */
export function planPathCount(plan: readonly RepoRestore[]): number {
  return plan.reduce((total, repo) => total + repo.paths.length, 0);
}

// Git also follows symlink ancestors when hashing or removing a leaf path.
// Check every component before any working-tree read, restore or deletion.
const REPO_SAFE_PATH = `safe_path() {
  case "$1" in ''|/*|../*|*/../*|*/..|./*|*//*) return 1;; esac
  rest="$1"; prefix=.
  while [ -n "$rest" ]; do
    part=\${rest%%/*}
    case "$part" in .|..|.git|${WORKSPACE_STORE}) return 1;; esac
    prefix="$prefix/$part"
    [ ! -L "$prefix" ] || return 1
    case "$rest" in */*) [ ! -e "$prefix" ] || [ -d "$prefix" ] || return 1; rest=\${rest#*/};; *) rest=;; esac
  done
}
`;

// Directory descriptors keep a raced parent or leaf symlink from redirecting
// filesystem writes. Content/mode conflict checks are still best effort.
const FD_RESTORE_SCRIPT = `import fnmatch, os, stat, subprocess, sys, uuid

OVERLAY = os.environ.get('VALET_WORKSPACE_FILES') == '1'
EXCLUDED = ${JSON.stringify(WORKSPACE_EXCLUDED_NAMES)}
GIT = ['git', '--git-dir=.valet-file-checkpoints', '--work-tree=.'] if OVERLAY else ['git']
FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

class UnsafePath(Exception):
    pass

def git(*args, **kwargs):
    return subprocess.run(GIT + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, **kwargs).stdout

def tree_entry(commit, path):
    data = git('ls-tree', '-z', '--full-tree', commit, '--', ':(literal)' + path)
    if not data:
        return None
    mode, kind, oid = data.split(b'\\t', 1)[0].split()
    return mode.decode(), oid.decode()

def fail(message):
    print(message + ' Files were left unchanged.', file=sys.stderr)
    sys.exit(1)

def exists(fd, name):
    try:
        os.stat(name, dir_fd=fd, follow_symlinks=False)
        return True
    except FileNotFoundError:
        return False

def check_overlay_repo(fd):
    if OVERLAY and (exists(fd, '.git') or (exists(fd, 'HEAD') and exists(fd, 'objects'))):
        raise UnsafePath()

def parts_for(path):
    parts = path.split('/')
    if any(part in ('', '.', '..', '.git', '.valet-file-checkpoints') for part in parts):
        raise UnsafePath()
    if OVERLAY and any(fnmatch.fnmatchcase(part, pattern) for part in parts for pattern in EXCLUDED):
        raise UnsafePath()
    return parts

def parent_for(root, parts, create=False):
    fd = os.dup(root)
    try:
        check_overlay_repo(fd)
        for part in parts[:-1]:
            try:
                child = os.open(part, FLAGS, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    os.close(fd)
                    return None
                try:
                    os.mkdir(part, dir_fd=fd)
                except FileExistsError:
                    pass
                child = os.open(part, FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
            check_overlay_repo(fd)
        return fd
    except BaseException:
        os.close(fd)
        raise

def current_entry(parent, leaf):
    if parent is None:
        return None
    try:
        fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    except FileNotFoundError:
        return None
    except OSError:
        return ('other', 'other')
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            return ('other', 'other')
        mode = '100755' if info.st_mode & stat.S_IXUSR else '100644'
        # Hash bytes through the opened descriptor, never through the path.
        oid = git('hash-object', '--stdin', stdin=fd).decode().strip()
        return mode, oid
    finally:
        os.close(fd)

try:
    plan = [line.rstrip('\\n').split('\\t') for line in sys.stdin if line.rstrip('\\n')]
    if any(len(row) != 3 for row in plan):
        fail('The checkpoint path format is invalid.')
    entries = {}
    # Every object is checked before any working-tree mutation.
    for path, source, expected in plan:
        for commit in (source, expected):
            try:
                git('cat-file', '-e', commit + '^{commit}')
            except subprocess.CalledProcessError:
                fail('Checkpoint commits are missing.')
            try:
                entry = tree_entry(commit, path)
            except subprocess.CalledProcessError:
                fail('Checkpoint trees are missing.')
            if entry is not None:
                try:
                    git('cat-file', '-e', entry[1])
                except subprocess.CalledProcessError:
                    fail('Checkpoint file objects are missing.')
            entries[(commit, path)] = entry
    if os.environ.get('VALET_PREFLIGHT') == '1':
        sys.exit(0)
    root = os.open('.', FLAGS)
    try:
        for path, source, expected in plan:
            parent = None
            temporary = None
            try:
                parts = parts_for(path)
                leaf = parts[-1]
                parent = parent_for(root, parts)
                want = None if os.environ.get('VALET_SEED') == '1' else entries[(expected, path)]
                have = current_entry(parent, leaf)
                original = entries[(source, path)]
                if have != want or (original is not None and original[0] not in ('100644', '100755')):
                    print('skipped\\t' + path, flush=True)
                    continue
                if original is None:
                    if parent is not None:
                        try:
                            os.unlink(leaf, dir_fd=parent)
                        except FileNotFoundError:
                            pass
                    print('removed\\t' + path, flush=True)
                    continue
                if parent is None:
                    parent = parent_for(root, parts, create=True)
                # A new inode and descriptor-relative replace cannot write
                # through a raced leaf symlink or an outside hard link.
                temporary = '.valet-restore-' + uuid.uuid4().hex
                fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                try:
                    subprocess.run(GIT + ['cat-file', 'blob', original[1]], stdout=fd, stderr=subprocess.PIPE, check=True)
                    os.fchmod(fd, 0o755 if original[0] == '100755' else 0o644)
                finally:
                    os.close(fd)
                os.replace(temporary, leaf, src_dir_fd=parent, dst_dir_fd=parent)
                temporary = None
                print('restored\\t' + path, flush=True)
            except (UnsafePath, OSError):
                print('skipped\\t' + path, flush=True)
            finally:
                if temporary is not None and parent is not None:
                    try:
                        os.unlink(temporary, dir_fd=parent)
                    except FileNotFoundError:
                        pass
                if parent is not None:
                    os.close(parent)
    finally:
        os.close(root)
except (OSError, subprocess.CalledProcessError, ValueError) as error:
    print('File restore failed. Retry with a complete checkpoint. ' + str(error), file=sys.stderr)
    sys.exit(1)
`;
const RESTORE_SCRIPT = `python3 -c ${q(FD_RESTORE_SCRIPT)}`;

export interface RepoRestoreResult {
  repo: string;
  restored: string[];
  removed: string[];
  skipped: string[];
  /** The snapshot taken before the restore, which a return uses to bring the files back. */
  restorePoint?: string;
  failed?: string;
}

// The shell inherits an opened directory, not a cwd resolved through a saved
// path. Open each component relative to its parent without following links.
const PIN_REPO_CWD = `import os, sys
try:
    path = sys.argv[1]
    parts = [] if path == '.' else path.split('/')
    if any(part in ('', '.', '..', '.git', '${WORKSPACE_STORE}') for part in parts):
        raise OSError('invalid repository path')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open('.', flags)
    for part in parts:
        child = os.open(part, flags, dir_fd=fd)
        os.close(fd)
        fd = child
    os.fchdir(fd)
    os.close(fd)
    os.environ['PWD'] = os.getcwd()
    os.execvpe('sh', ['sh', '-c', sys.argv[2]], os.environ)
except OSError as error:
    print('The checkpoint repository path could not be pinned. Use a repository inside the working directory before retrying. ' + str(error), file=sys.stderr)
    sys.exit(1)
`;

function pinnedRepoExec(sandbox: Sandbox, workspace: string, repo: string): Sandbox["exec"] {
  return (script, options) => sandbox.exec(
    `command -v python3 >/dev/null 2>&1 || { echo 'Python 3 is required for safe file restore. Install Python 3 before retrying.' >&2; exit 1; }\npython3 -c ${q(PIN_REPO_CWD)} ${q(repo === WORKSPACE_FILES ? "." : repo)} ${q(script)}`,
    { ...options, cwd: workspace },
  );
}

/** Validate from the workspace before a saved repo path becomes an exec cwd. */
async function validateRestoreRepo(sandbox: Sandbox, workspace: string, repo: string): Promise<void> {
  if (repo === "." || repo === WORKSPACE_FILES) return;
  const unsafe = () => new Error("The checkpoint repository path is unsafe. Use a repository inside the working directory before retrying.");
  if (repo.startsWith("/") || repo.split("/").some((part) => !part || part === "." || part === "..")) throw unsafe();
  const checked = await sandbox.exec(REPO_SAFE_PATH + 'safe_path "$VALET_REPO"', {
    cwd: workspace, timeout: SNAPSHOT_TIMEOUT_MS, env: { VALET_REPO: repo },
  });
  if (checked.exitCode !== 0 || checked.timedOut) throw unsafe();
}

/**
 * Restore each repository's paths. A restore point of the current working
 * tree comes first, under `restoreRef(repo)`. A repository whose restore
 * point fails is left untouched.
 */
export async function restorePaths(
  sandbox: Sandbox,
  workspace: string,
  plan: readonly RepoRestore[],
  restoreRef: (repo: string) => string,
  onPrepared?: (repo: string, restorePoint: string) => Promise<void>,
): Promise<RepoRestoreResult[]> {
  const results: RepoRestoreResult[] = [];
  for (const repo of plan) {
    const result: RepoRestoreResult = { repo: repo.repo, restored: [], removed: [], skipped: [...repo.skipped ?? []] };
    results.push(result);
    if (repo.unavailable) {
      result.failed = `Checkpoint coverage unavailable: ${repo.unavailable}`;
      continue;
    }
    if (repo.paths.length === 0) continue;
    const dir = repoDir(workspace, repo.repo);
    try {
      await validateRestoreRepo(sandbox, workspace, repo.repo);
      const exec = pinnedRepoExec(sandbox, workspace, repo.repo);
      const recovery = await takeSnapshot(exec, dir, restoreRef(repo.repo), repo.repo === WORKSPACE_FILES);
      if (recovery.partial) throw new Error("The recovery snapshot is partial. Files were left unchanged. Reduce untracked file size before retrying.");
      result.restorePoint = recovery.commit;
      const script = (repo.repo === WORKSPACE_FILES ? WORKSPACE_GIT + WORKSPACE_SAFE_PATH : REPO_SAFE_PATH) + RESTORE_SCRIPT;
      const options = {
        cwd: dir, timeout: RESTORE_TIMEOUT_MS,
        stdin: repo.paths.map((p) => `${p.path}\t${p.source}\t${p.expected}\n`).join(""),
      };
      const preflight = await exec(script, { ...options, env: { VALET_PREFLIGHT: "1", VALET_WORKSPACE_FILES: repo.repo === WORKSPACE_FILES ? "1" : "0" } });
      if (preflight.exitCode !== 0 || preflight.timedOut) throw new Error((preflight.stderr || "Checkpoint preflight timed out. Files were left unchanged.").trim().slice(0, 300));
      // A durable journal must be committed before the first working-tree write.
      await onPrepared?.(repo.repo, recovery.commit);
      await validateRestoreRepo(sandbox, workspace, repo.repo);
      const run = await exec(script, { ...options, env: { VALET_WORKSPACE_FILES: repo.repo === WORKSPACE_FILES ? "1" : "0" } });
      for (const line of run.stdout.split("\n")) {
        const [outcome, path] = line.split("\t");
        if (!path) continue;
        if (outcome === "restored") result.restored.push(path);
        else if (outcome === "removed") result.removed.push(path);
        else if (outcome === "skipped") result.skipped.push(path);
      }
      if (run.exitCode !== 0 || run.timedOut) {
        result.failed = (run.stderr || "the restore timed out").trim().slice(0, 300);
      }
    } catch (err) {
      result.failed = err instanceof Error ? err.message : String(err);
    }
  }
  return results;
}

/** One repository's state for a fork's new working directory. */
export interface ForkSeedRepo {
  /** Relative to the working directory, the same in both threads. */
  repo: string;
  /** The snapshot to reproduce: the last checkpoint at or before the fork point. */
  snapshot: string;
  branch?: string;
  /** Export must report this coverage gap instead of bundling stale state. */
  unavailable?: string;
  /** Only snapshots referenced by this copied path, including usable return notes. */
  history?: string[];
  /** Successful note restores to apply to snapshot in a temporary Git index. */
  restoredBases?: Record<string, string>;
}

/** The latest checkpoint per repository among `entries` (a fork's copied path). */
export function planForkSeed(entries: readonly SessionEntry[]): ForkSeedRepo[] {
  const latest = new Map<string, ForkSeedRepo>();
  const history = new Map<string, Set<string>>();
  const keep = (repo: string, commits: string[]) => {
    const known = history.get(repo) ?? new Set<string>();
    for (const commit of commits) known.add(commit);
    history.set(repo, known);
  };
  for (const entry of entries) {
    if (entry.type === "branch_summary") {
      for (const files of readBranchNote(entry.metadata)?.files ?? []) {
        if (files.restorePoint && files.bases) keep(files.repo, [files.restorePoint, ...Object.values(files.bases)]);
        if (files.failed) {
          latest.set(files.repo, { repo: files.repo, snapshot: "", unavailable: files.failed });
          continue;
        }
        const changed = [...files.restored, ...files.removed];
        if (!files.restorePoint || changed.some((path) => !files.bases?.[path])) {
          if (changed.length > 0) latest.set(files.repo, { repo: files.repo, snapshot: "", unavailable: "The file restore has no complete checkpoint. Take a new checkpoint before forking files." });
          continue;
        }
        keep(files.repo, [files.restorePoint]);
        latest.set(files.repo, {
          repo: files.repo, snapshot: files.restorePoint,
          ...(latest.get(files.repo)?.branch ? { branch: latest.get(files.repo)?.branch } : {}),
          ...(changed.length > 0 ? { restoredBases: Object.fromEntries(changed.map((path) => [path, files.bases![path]!])) } : {}),
        });
      }
    }
    if (entry.type !== "message" || entry.role !== "user") continue;
    const checkpoint = readTurnCheckpoint(entry.metadata);
    for (const repo of checkpoint?.repos ?? []) {
      keep(repo.repo, [repo.before, repo.after]);
      latest.set(repo.repo, { repo: repo.repo, snapshot: repo.after, ...(repo.branch ? { branch: repo.branch } : {}),
        ...(repo.partial ? { unavailable: "The checkpoint pair is partial. Take a complete checkpoint before forking files." } : {}) });
    }
    for (const failed of checkpoint?.unavailable ?? []) {
      latest.set(failed.repo, { repo: failed.repo, snapshot: "", unavailable: failed.reason });
    }
  }
  // A root repository owns all working-directory paths after conversion.
  if (latest.has(".")) latest.delete(WORKSPACE_FILES);
  return [...latest.values()].map((seed) => ({ ...seed, history: [...history.get(seed.repo) ?? []] }));
}

/** The largest git bundle a fork carries for one repository. */
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

/**
 * A temporary bundle file in the repository's git directory. Sandbox file
 * calls reach only the working directory, and a file there never shows as an
 * untracked change. `git` is the path for commands that run with `cwd: dir`
 * (inside a container, a host path does not exist); `io` is the path for the
 * sandbox file calls. Throws when `dir` is not a git repository.
 */
async function bundleFile(sandbox: Sandbox, dir: string, workspaceFiles = false): Promise<{ git: string; io: string }> {
  const result = await sandbox.exec(`${workspaceFiles ? WORKSPACE_GIT : ""}git rev-parse --git-path ${q(`valet-fork-seed-${crypto.randomUUID()}.bundle`)}`, {
    cwd: dir,
    timeout: SNAPSHOT_TIMEOUT_MS,
  });
  const path = result.stdout.trim();
  if (result.exitCode !== 0 || !path) throw new Error(`not a git repository: ${result.stderr.trim().slice(0, 300)}`);
  // A linked worktree's git directory is an absolute path, which the
  // sandbox file calls map like any other path under the working directory.
  return { git: path, io: path.startsWith("/") ? path : `${dir}/${path}` };
}

/** Build note state without reading or writing the live working tree. */
async function composeNoteSnapshot(sandbox: Sandbox, workspace: string, seed: ForkSeedRepo): Promise<void> {
  if (!seed.restoredBases) return;
  const paths = Object.entries(seed.restoredBases);
  if (paths.some(([path]) => !path || /[\t\n]/.test(path))) throw new Error("Unsupported checkpoint restore path. Take a new checkpoint before forking files.");
  const result = await sandbox.exec(`${seed.repo === WORKSPACE_FILES ? WORKSPACE_GIT : ""}set -e
idx=$(mktemp)
listing=$(mktemp)
trap 'rm -f "$idx" "$listing"' EXIT
rm -f "$idx"
export GIT_INDEX_FILE="$idx"
git read-tree "$VALET_SNAPSHOT"
tab=$(printf '\\t')
while IFS="$tab" read -r path source; do
  git cat-file -e "$source^{commit}"
  git ls-tree --full-tree "$source" -- ":(literal)$path" > "$listing"
  if [ -s "$listing" ]; then
    mode=$(awk 'NR==1 { print $1 }' "$listing")
    object=$(awk 'NR==1 { print $3 }' "$listing")
    case "$mode" in 100644|100755|120000) ;; *) echo 'Unsupported checkpoint file mode.' >&2; exit 1;; esac
    git cat-file -e "$object"
    git update-index --add --cacheinfo "$mode,$object,$path"
  else git update-index --force-remove -- "$path"
  fi
done
tree=$(git write-tree)
parent=$(git rev-parse -q --verify "$VALET_SNAPSHOT^1" || true)
if [ -n "$parent" ]; then commit=$(git commit-tree "$tree" -p "$parent" -m 'valet restored checkpoint')
else commit=$(git commit-tree "$tree" -m 'valet restored checkpoint')
fi
git update-ref "$VALET_REF" "$commit"
printf '%s\\n' "$commit"`, {
    cwd: repoDir(workspace, seed.repo), timeout: SNAPSHOT_TIMEOUT_MS,
    env: { ...GIT_IDENTITY, VALET_SNAPSHOT: seed.snapshot, VALET_REF: `refs/valet/fork-composed/${crypto.randomUUID()}` },
    stdin: paths.map(([path, commit]) => `${path}\t${commit}\n`).join(""),
  });
  const commit = result.stdout.trim();
  if (result.exitCode !== 0 || result.timedOut || !/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new Error(`Restored checkpoint could not be composed. Take a new checkpoint before forking files. ${result.stderr.trim().slice(0, 200)}`);
  }
  // The caller records this finalized snapshot ID after exporting the bundle.
  seed.snapshot = commit;
  delete seed.restoredBases;
}

/**
 * A git bundle of `seed.snapshot` that leaves out what the remotes already
 * hold, so it stays small when the fork's working directory clones the same
 * remote. Finalizes `seed.snapshot` when a note needs a composed state.
 * Returns the bundle bytes.
 */
export async function exportSeedBundle(sandbox: Sandbox, workspace: string, seed: ForkSeedRepo): Promise<Uint8Array> {
  const label = seed.repo === WORKSPACE_FILES ? "Working directory" : seed.repo;
  if (seed.unavailable) throw new Error(`Checkpoint coverage unavailable for ${label}: ${seed.unavailable}`);
  await composeNoteSnapshot(sandbox, workspace, seed);
  const prefix = `refs/valet/fork-exports/${crypto.randomUUID()}`;
  const commits = [...new Set([seed.snapshot, ...seed.history ?? []])];
  const refs = commits.map((_, index) => `${prefix}/${index}`);
  const revisions = refs.map(q).join(" ");
  const dir = repoDir(workspace, seed.repo);
  const file = await bundleFile(sandbox, dir, seed.repo === WORKSPACE_FILES);
  // A bundle carries refs, not bare commits, so name the snapshot first. A
  // repository with no remote bundles its whole history.
  try {
    const result = await sandbox.exec(
      [
        "set -e",
        seed.repo === WORKSPACE_FILES ? WORKSPACE_GIT : "",
        ...refs.map((ref, index) => `git update-ref ${q(ref)} ${q(commits[index]!)}`),
        `if [ -n "$(git for-each-ref --count=1 refs/remotes)" ]; then git bundle create ${q(file.git)} ${revisions} --not --remotes 2>/dev/null; else git bundle create ${q(file.git)} ${revisions} 2>/dev/null; fi`,
        `wc -c < ${q(file.git)}`,
      ].join("\n"),
      { cwd: dir, timeout: RESTORE_TIMEOUT_MS },
    );
    const size = Number.parseInt(result.stdout.trim(), 10);
    if (result.exitCode !== 0 || !Number.isFinite(size)) throw new Error(`bundle of ${label} failed: ${result.stderr.trim().slice(0, 300)}`);
    if (size > MAX_BUNDLE_BYTES) throw new Error(`${label} changed more than ${MAX_BUNDLE_BYTES / 1024 / 1024} MB since its remote`);
    return await sandbox.readBinary(file.io);
  } finally {
    await sandbox.exec(`${seed.repo === WORKSPACE_FILES ? WORKSPACE_GIT : ""}${refs.map((ref) => `git update-ref -d ${q(ref)}`).join("\n")}`, { cwd: dir, timeout: SNAPSHOT_TIMEOUT_MS }).catch(() => undefined);
    await sandbox.rm(file.io).catch(() => undefined);
  }
}

const APPLY_SEED_SCRIPT = `set -e
git fetch -q "$VALET_BUNDLE" "$VALET_SNAPSHOT:refs/valet/fork-imports/$VALET_SNAPSHOT" 'refs/valet/*:refs/valet/fork-history/*'
base=$(git rev-parse -q --verify "$VALET_SNAPSHOT^1" || true)
if [ -n "$base" ]; then
  if [ -n "$VALET_BRANCH" ]; then git checkout -q -B "$VALET_BRANCH" "$base"; else git checkout -q --detach "$base"; fi
  git diff --name-only --diff-filter=D -z "$base" "$VALET_SNAPSHOT" | xargs -0 rm -f -- 2>/dev/null || true
fi
git restore --source="$VALET_SNAPSHOT" --worktree -- .
git diff --name-only -z HEAD "$VALET_SNAPSHOT" | tr '\\0' '\\n' | head -n 200`;

/**
 * Reproduce a fork seed in this sandbox's copy of the repository: check out
 * the commit the snapshot was taken on, then put the snapshot's working tree
 * on top, so uncommitted and untracked changes come along unstaged. Returns
 * the paths that differ from that commit.
 */
export async function applySeedBundle(sandbox: Sandbox, workspace: string, seed: ForkSeedRepo, bundle: Uint8Array): Promise<string[]> {
  const dir = repoDir(workspace, seed.repo);
  if (seed.repo === WORKSPACE_FILES) {
    // Initialize only our object store, never the target workspace's .git.
    await snapshotRepo(sandbox, dir, `refs/valet/seed-before/${crypto.randomUUID()}`, true);
    const file = await bundleFile(sandbox, dir, true);
    try {
      await sandbox.writeBinary(file.io, bundle);
      const imported = await sandbox.exec(WORKSPACE_GIT + `git fetch -q ${q(file.git)} ${q(`${seed.snapshot}:refs/valet/fork-imports/${seed.snapshot}`)} 'refs/valet/*:refs/valet/fork-history/*' && git ls-tree -r --name-only -z ${q(seed.snapshot)}`, { cwd: dir, timeout: RESTORE_TIMEOUT_MS });
      if (imported.exitCode !== 0 || imported.timedOut) throw new Error("workspace seed import failed");
      const paths = imported.stdout.split("\0").filter(Boolean);
      if (paths.some((path) => /[\t\n]/.test(path))) throw new Error("unsupported workspace seed path");
      // Existing target files belong to that workspace: only create missing
      // files. A partial seed is an explicit failure, never silent overwrite.
      const run = await sandbox.exec(WORKSPACE_GIT + WORKSPACE_SAFE_PATH + RESTORE_SCRIPT, {
        cwd: dir, timeout: RESTORE_TIMEOUT_MS,
        env: { VALET_WORKSPACE_FILES: "1", VALET_SEED: "1" },
        stdin: paths.map((path) => `${path}\t${seed.snapshot}\t${seed.snapshot}\n`).join(""),
      });
      if (run.exitCode !== 0 || run.timedOut || run.stdout.includes("skipped\t")) throw new Error("workspace seed could not copy all paths safely (existing or excluded paths)");
      return paths;
    } finally {
      await sandbox.rm(file.io).catch(() => undefined);
    }
  }
  let file = await bundleFile(sandbox, dir).catch(() => undefined);
  // A repository the source thread made itself has no remote, so workspace
  // prep did not clone it here, and its bundle holds its whole history.
  // Start it empty when nothing is at its path.
  const created = !file && (await sandbox.exec(
    `if [ -e ${q(seed.repo)} ] && [ -n "$(ls -A ${q(seed.repo)})" ]; then exit 1; fi; mkdir -p ${q(seed.repo)} && git -C ${q(seed.repo)} init -q`,
    { cwd: workspace, timeout: SNAPSHOT_TIMEOUT_MS },
  )).exitCode === 0;
  if (created) file = await bundleFile(sandbox, dir).catch(() => undefined);
  if (!file) throw new Error(`${seed.repo} is in this working directory but is not a git repository`);
  try {
    await sandbox.writeBinary(file.io, bundle);
    const result = await sandbox.exec(APPLY_SEED_SCRIPT, {
      cwd: dir,
      timeout: RESTORE_TIMEOUT_MS,
      env: { ...GIT_IDENTITY, VALET_BUNDLE: file.git, VALET_SNAPSHOT: seed.snapshot, VALET_BRANCH: seed.branch ?? "" },
    });
    if (result.exitCode !== 0 || result.timedOut) {
      // A half-made repository only hides the failure. The path was empty
      // or missing before this call, so empty it again.
      if (created) await sandbox.exec(`find ${q(seed.repo)} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`, { cwd: workspace, timeout: SNAPSHOT_TIMEOUT_MS }).catch(() => undefined);
      const lacking = /lacks these prerequisite commits/.test(result.stderr);
      throw new Error(lacking
        ? `this working directory has no clone of ${seed.repo} with the commits its changes build on`
        : `applying files to ${seed.repo} failed: ${(result.stderr || "timed out").trim().slice(0, 300)}`);
    }
    return result.stdout.split("\n").filter(Boolean);
  } finally {
    await sandbox.rm(file.io).catch(() => undefined);
  }
}
