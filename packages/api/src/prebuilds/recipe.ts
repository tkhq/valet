/**
 * Pure recipe engine for sandbox image prebuilds (sandbox images v2 plan,
 * Task 1). No I/O happens in this module — callers inject a file listing
 * and a `read(path)` function (e.g. backed by a git tree, a tarball, or a
 * local checkout) so this logic is trivially unit-testable and reusable
 * from both the API (prebuild trigger route) and any future CLI.
 *
 * Detection matrix (spec decision 6). Root-level lockfiles only this pass —
 * a monorepo with nested `packages/foo/pnpm-lock.yaml` will NOT get a step
 * for that nested lockfile. Composable: several matrix entries can fire for
 * the same repo (e.g. a Node + Python monorepo gets both `pnpm install`
 * and `uv sync`), each contributing one `RecipeStep`. Matrix order below is
 * also the emitted step order, which matters for determinism.
 */
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

export interface RecipeStep {
  /** Stable identifier — the fetch-on-start diff keys on this, so it must
   * never change once shipped for a given lockfile kind. */
  id: string;
  /** The lockfile (root-relative path) whose presence triggered this step. */
  lockfile: string;
  /** The install/fetch command to run in the repo directory. */
  command: string;
}

interface DetectionRule {
  id: string;
  lockfile: string;
  command: string;
}

const DETECTION_MATRIX: DetectionRule[] = [
  { id: "pnpm-install", lockfile: "pnpm-lock.yaml", command: "pnpm install --frozen-lockfile" },
  { id: "npm-ci", lockfile: "package-lock.json", command: "npm ci" },
  { id: "yarn-install", lockfile: "yarn.lock", command: "yarn install --frozen-lockfile" },
  { id: "uv-sync", lockfile: "uv.lock", command: "uv sync" },
  {
    id: "pip-install",
    lockfile: "requirements.txt",
    command: "pip install -r requirements.txt",
  },
  { id: "cargo-fetch", lockfile: "Cargo.lock", command: "cargo fetch" },
  { id: "go-mod-download", lockfile: "go.sum", command: "go mod download" },
];

/**
 * Detects the install recipe for a repo from its root-level file listing.
 * `read` is accepted for interface symmetry with `loadPrebuildOverride` and
 * so future matrix entries that need to inspect lockfile *contents* (e.g.
 * distinguishing pnpm workspace roots) can do so without a signature
 * change — this pass doesn't read any file contents.
 */
export async function detectRecipe(
  files: string[],
  _read: (path: string) => Promise<string | null>,
): Promise<RecipeStep[]> {
  const present = new Set(files);
  const steps: RecipeStep[] = [];
  for (const rule of DETECTION_MATRIX) {
    if (present.has(rule.lockfile)) {
      steps.push({ id: rule.id, lockfile: rule.lockfile, command: rule.command });
    }
  }
  return steps;
}

export interface PrebuildOverride {
  image?: string;
  setup?: string[];
  skipDetect?: boolean;
}

/**
 * Loads `.valet/prebuild.yaml` if present. Returns `null` when the file
 * doesn't exist. Uses the `yaml` package (already a dependency of
 * `packages/api`) rather than a hand-rolled parser, per the task brief's
 * "use it if reachable" instruction.
 */
export async function loadPrebuildOverride(
  read: (path: string) => Promise<string | null>,
): Promise<PrebuildOverride | null> {
  const raw = await read(".valet/prebuild.yaml");
  if (raw === null) return null;
  const parsed: unknown = parseYaml(raw);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(".valet/prebuild.yaml must contain a YAML mapping");
  }
  const obj = parsed as Record<string, unknown>;
  const override: PrebuildOverride = {};
  if (obj.image !== undefined) {
    if (typeof obj.image !== "string") throw new Error(".valet/prebuild.yaml: image must be a string");
    override.image = obj.image;
  }
  if (obj.setup !== undefined) {
    if (!Array.isArray(obj.setup) || obj.setup.some((s) => typeof s !== "string")) {
      throw new Error(".valet/prebuild.yaml: setup must be a string array");
    }
    override.setup = obj.setup as string[];
  }
  if (obj.skipDetect !== undefined) {
    if (typeof obj.skipDetect !== "boolean") {
      throw new Error(".valet/prebuild.yaml: skipDetect must be a boolean");
    }
    override.skipDetect = obj.skipDetect;
  }
  return override;
}

export interface ResolvedRecipe {
  /** Lockfile-detected install steps, empty when `skipDetect` is set. */
  recipe: RecipeStep[];
  /** Extra setup commands from the override, run after `recipe` steps. */
  setup: string[];
  /** Override base image ref, when the repo pins one. */
  image?: string;
}

/**
 * Combines `detectRecipe` and `loadPrebuildOverride` with the documented
 * precedence: `skipDetect: true` in the override suppresses lockfile
 * detection entirely (a "setup-only" repo declares everything itself via
 * `setup`); otherwise the detected steps run first, followed by the
 * override's `setup` commands. `image` always comes from the override,
 * independent of `skipDetect`.
 */
export async function resolveRecipe(
  files: string[],
  read: (path: string) => Promise<string | null>,
): Promise<ResolvedRecipe> {
  const override = await loadPrebuildOverride(read);
  const skipDetect = override?.skipDetect ?? false;
  const recipe = skipDetect ? [] : await detectRecipe(files, read);
  return {
    recipe,
    setup: override?.setup ?? [],
    image: override?.image,
  };
}

/** Canonical, stable JSON used to hash a recipe+setup pair for the cache
 * identity label — field order is fixed (per step: id, lockfile, command)
 * so the hash is deterministic regardless of input object key order, and
 * covers full step *content* (not just `id`) so editing a detection-matrix
 * command (e.g. adding a flag) changes the identity even though the step's
 * `id`/`lockfile` are unchanged. `baseImage` and `cloneUrl@commitSha` are
 * NOT included here — they're already folded into the label string
 * (`${baseImage}|${cloneUrl}@${commitSha}|${hash}`) by the caller. */
function canonicalRecipeJson(recipe: RecipeStep[], setup: string[]): string {
  return JSON.stringify({
    steps: recipe.map((s) => ({ id: s.id, lockfile: s.lockfile, command: s.command })),
    setup,
  });
}

/** In-image path where the prebuild bakes the cloned/checked-out repo.
 * The fetch-on-start prep (later task) stages this path into the live
 * session workspace rather than re-cloning. */
export const PREBUILT_REPO_PATH = "/prebuilt/repo";

const ASKPASS_PATH = "/tmp/valet-git-askpass.sh";

export interface GenerateDockerfileOpts {
  baseImage: string;
  cloneUrl: string;
  commitSha: string;
  recipe: RecipeStep[];
  setup?: string[];
}

/**
 * Renders a deterministic Dockerfile for a prebuild: same inputs always
 * produce byte-identical output (golden-tested). The clone step uses a
 * BuildKit secret mount (`--mount=type=secret,id=git-token`) plus a
 * one-shot `GIT_ASKPASS` script that `cat`s the mounted secret file at
 * clone time — the token itself is never written to a layer, an `ARG`, or
 * an `ENV`; only the *path* to the mounted secret (`/run/secrets/...`) and
 * the askpass script *path* appear in the image. The askpass script is
 * generated and removed within the same `RUN` so it never persists as a
 * layer of its own.
 *
 * The repo is baked at `PREBUILT_REPO_PATH`; per-recipe-step install
 * commands and override `setup` commands run there via `WORKDIR`.
 */
export function generateDockerfile(opts: GenerateDockerfileOpts): string {
  const { baseImage, cloneUrl, commitSha, recipe, setup = [] } = opts;

  const lines: string[] = [];
  lines.push(`FROM ${baseImage}`);
  lines.push("");
  lines.push("RUN --mount=type=secret,id=git-token sh -c '\\");
  lines.push(
    `  printf "#!/bin/sh\\ncase \\"\\$1\\" in\\n  *[Uu]sername*) echo x-access-token ;;\\n  *) cat /run/secrets/git-token ;;\\nesac\\n" > ${ASKPASS_PATH} && \\`,
  );
  lines.push(`  chmod +x ${ASKPASS_PATH} && \\`);
  lines.push(
    `  GIT_ASKPASS=${ASKPASS_PATH} git clone "${cloneUrl}" ${PREBUILT_REPO_PATH} && \\`,
  );
  lines.push(`  rm -f ${ASKPASS_PATH}'`);
  lines.push("");
  lines.push(`WORKDIR ${PREBUILT_REPO_PATH}`);
  lines.push(`RUN git checkout ${commitSha}`);

  for (const step of recipe) {
    lines.push("");
    lines.push(`RUN ${step.command}`);
  }

  for (const cmd of setup) {
    lines.push("");
    lines.push(`RUN ${cmd}`);
  }

  const identityHash = createHash("sha256").update(canonicalRecipeJson(recipe, setup)).digest("hex");
  const identity = `${baseImage}|${cloneUrl}@${commitSha}|${identityHash}`;
  lines.push("");
  lines.push(`LABEL valet.prebuild.identity="${identity}"`);
  lines.push("");

  return lines.join("\n");
}
