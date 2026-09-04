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
import type { SandboxResources } from "@valet/engine";
import { parse as parseYaml } from "yaml";
import { parseStorageQuantity } from "@valet/sandbox-kubernetes";

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
 * The binary each detected step needs, keyed by step id.
 *
 * Detection infers a step from a lockfile. It cannot know the image has the
 * toolchain to run it, and the stock image has almost none of them: it ships
 * node, npm and bun, and no cargo, go, python, pip, uv or yarn. So six of
 * the seven rules below produce a `RUN` that exits 127, the build fails, and
 * every affected repo leaves a Failed job behind. A Rust repo made this
 * visible (TKAI-354) but Go, Python and yarn repos fail the same way.
 *
 * Keyed by `id` rather than carried on `RecipeStep`, because the recipe is
 * hashed into bake identity: a new field would change every hash and rebake
 * repos whose builds were fine.
 */
const STEP_REQUIRES: Readonly<Record<string, string>> = {
  "pnpm-install": "pnpm",
  "npm-ci": "npm",
  "yarn-install": "yarn",
  "uv-sync": "uv",
  "pip-install": "pip",
  "cargo-fetch": "cargo",
  "go-mod-download": "go",
};

/** Root-level lockfile paths the detection matrix checks for, in matrix
 * order. Exported so callers that need to know WHICH paths to fetch before
 * calling `detectRecipe` (e.g. the prebuild service's GitHub Contents-API
 * probe, Task 3) don't hardcode a second copy of this list. */
export const CANDIDATE_LOCKFILES: readonly string[] = DETECTION_MATRIX.map((r) => r.lockfile);

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
  docker?: boolean;
  resources?: PrebuildResources;
  /** Workspace volume size this repo requests (Kubernetes quantity, e.g.
   * "4Gi"). The api reads it at session create time. Like `docker`, this is a
   * session runtime knob in the repo config. Kubernetes bounds the claim
   * target by the deploy default floor and `VALET_SANDBOX_WORKSPACE_MAX` cap.
   * A fresh claim starts at that target. If this declaration is present during
   * adoption, an undersized claim can grow toward the same target. The provider
   * never requests a shrink or waits for capacity during adoption. */
  workspaceStorage?: string;
  /**
   * REPO-INDEPENDENT setup commands (toolchain installs), split out of
   * `setup` so they bake into a chained BASE image instead of re-running on
   * every commit's rebake. The platform materializes them as a per-repo base
   * source (`repo-base:<fullName>`): its bake is identity-keyed on these
   * commands, so it rebuilds only when they change, and the repo bake FROMs
   * it. Commands here run WITHOUT the repo checkout (before any clone) — a
   * command that reads repo files belongs in `setup`.
   */
  baseSetup?: string[];
}

/** Sandbox CPU and memory requested by a repository prebuild. */
export type PrebuildResources = Pick<SandboxResources, "cpu" | "memory">;

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
  if (obj.docker !== undefined) {
    if (typeof obj.docker !== "boolean") {
      throw new Error(".valet/prebuild.yaml: docker must be a boolean");
    }
    override.docker = obj.docker;
  }
  if (obj.resources !== undefined) {
    if (typeof obj.resources !== "object" || obj.resources === null || Array.isArray(obj.resources)) {
      throw new Error(
        '.valet/prebuild.yaml: resources must be a mapping with optional cpu and memory fields — use resources: { cpu: 2, memory: "4Gi" }',
      );
    }
    const resourcesObj = obj.resources as Record<string, unknown>;
    const resources: PrebuildResources = {};
    if (resourcesObj.cpu !== undefined) {
      if (typeof resourcesObj.cpu !== "number") {
        throw new Error(
          '.valet/prebuild.yaml: resources.cpu must be a positive finite number — use resources: { cpu: 2, memory: "4Gi" }',
        );
      }
      if (!Number.isFinite(resourcesObj.cpu) || resourcesObj.cpu <= 0) {
        throw new Error(
          '.valet/prebuild.yaml: resources.cpu must be a positive finite number — use resources: { cpu: 2, memory: "4Gi" }',
        );
      }
      resources.cpu = resourcesObj.cpu;
    }
    if (resourcesObj.memory !== undefined) {
      if (typeof resourcesObj.memory !== "string") {
        throw new Error(
          '.valet/prebuild.yaml: resources.memory must be a positive quantity string — use resources: { cpu: 2, memory: "4Gi" }',
        );
      }
      const memory = resourcesObj.memory.trim();
      const bytes = parseStorageQuantity(memory);
      if (bytes === null || bytes <= 0) {
        throw new Error(
          `.valet/prebuild.yaml: resources.memory "${resourcesObj.memory}" must be a positive Kubernetes quantity — use resources: { cpu: 2, memory: "4Gi" }`,
        );
      }
      resources.memory = memory;
    }
    override.resources = resources;
  }
  if (obj.workspaceStorage !== undefined) {
    // Quote the value in YAML: an unquoted `4Gi` parses as a string, but a
    // bare number (`workspaceStorage: 4`) does not name a unit.
    if (typeof obj.workspaceStorage !== "string") {
      throw new Error('.valet/prebuild.yaml: workspaceStorage must be a quantity string like "4Gi"');
    }
    // Validate here, not only in the provider: the provider's fallback is a
    // SILENT 1Gi on the api pod, feedback the repo author never sees. A typo
    // like "8GB" (invalid k8s suffix) must fail loudly at read time, where
    // the failure is logged with the repo name.
    const bytes = parseStorageQuantity(obj.workspaceStorage);
    if (bytes === null || bytes <= 0) {
      throw new Error(
        `.valet/prebuild.yaml: workspaceStorage "${obj.workspaceStorage}" is not a positive Kubernetes quantity — use a form like "4Gi" or "500Mi"`,
      );
    }
    // Trimmed at source: every consumer trims defensively, but a padded
    // value emitted into a CR fails admission, so never store one.
    override.workspaceStorage = obj.workspaceStorage.trim();
  }
  if (obj.baseSetup !== undefined) {
    if (!Array.isArray(obj.baseSetup) || obj.baseSetup.some((s) => typeof s !== "string")) {
      throw new Error(".valet/prebuild.yaml: baseSetup must be a string array");
    }
    override.baseSetup = obj.baseSetup as string[];
  }
  return override;
}

export interface ResolvedRecipe {
  /** Lockfile-detected install steps, empty when `skipDetect` is set. */
  recipe: RecipeStep[];
  /** Extra setup commands from the override, run after `recipe` steps. */
  setup: string[];
  /** Repo-independent toolchain commands baked into a chained BASE image —
   * see `PrebuildOverride.baseSetup`. Empty when undeclared. */
  baseSetup: string[];
  /** Override base image ref, when the repo pins one. */
  image?: string;
  /** Docker daemon inside sandbox, when the repo enables it. */
  docker?: boolean;
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
    baseSetup: override?.baseSetup ?? [],
    image: override?.image,
    ...(override?.docker !== undefined ? { docker: override.docker } : {}),
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

/** Emits the shared recipe/setup `RUN` tail used by every repo Dockerfile
 * variant (platform bake and the CLI's local build), so the two cannot
 * drift: detected recipe steps are toolchain-guarded (skip, do not fail —
 * a detected step is Valet's inference from a lockfile, not something the
 * repo asked for); `setup` commands are NOT guarded — they are the repo's
 * own instruction, and a repo that asks for something the image cannot run
 * should hear about it as a failure rather than have it silently skipped. */
function emitStepRuns(lines: string[], recipe: RecipeStep[], setup: string[]): void {
  for (const step of recipe) {
    lines.push("");
    const needs = STEP_REQUIRES[step.id];
    if (needs === undefined) {
      lines.push(`RUN ${step.command}`);
      continue;
    }
    // The echo is what a reader sees instead of `127`.
    lines.push(
      `RUN command -v ${needs} >/dev/null 2>&1 && ${step.command} || ` +
        `echo "prebuild: no ${needs} in this image, skipping ${step.id}"`,
    );
  }

  for (const cmd of setup) {
    lines.push("");
    lines.push(`RUN ${cmd}`);
  }
}

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

  emitStepRuns(lines, recipe, setup);

  const identityHash = createHash("sha256").update(canonicalRecipeJson(recipe, setup)).digest("hex");
  const identity = `${baseImage}|${cloneUrl}@${commitSha}|${identityHash}`;
  lines.push("");
  lines.push(`LABEL valet.prebuild.identity="${identity}"`);
  lines.push("");

  return lines.join("\n");
}

export interface GenerateLocalDockerfileOpts {
  baseImage: string;
  recipe: RecipeStep[];
  setup?: string[];
  /** Repo-independent toolchain commands, emitted BEFORE the repo COPY —
   * mirroring the platform's chained base bake (they run without the repo
   * there too), and keeping their layers cached locally across commits. */
  baseSetup?: string[];
}

/**
 * Renders the LOCAL-BUILD variant of a repo prebuild Dockerfile — what
 * `valet prebuild build` runs against a checkout on the developer's machine.
 * Identical to `generateDockerfile` except for how the repo lands in the
 * image: `COPY . <PREBUILT_REPO_PATH>` from the build context (the CLI feeds
 * it a clean local `git clone` of the checkout, `.git` included — recipes
 * really do run git against it) instead of the secret-mount network clone,
 * which only works inside the platform (it needs a minted git token).
 * The recipe/setup `RUN` tail is emitted by the same code as the platform
 * bake (`emitStepRuns`), so a step that passes locally runs identically in
 * the real bake. Labeled `valet.prebuild.local` (not `.identity`) so a local
 * image can never satisfy a platform cache lookup.
 */
export function generateLocalDockerfile(opts: GenerateLocalDockerfileOpts): string {
  const { baseImage, recipe, setup = [], baseSetup = [] } = opts;
  const lines: string[] = [];
  lines.push(`FROM ${baseImage}`);
  for (const cmd of baseSetup) {
    lines.push("");
    lines.push(`RUN ${cmd}`);
  }
  lines.push("");
  lines.push(`COPY . ${PREBUILT_REPO_PATH}`);
  lines.push("");
  lines.push(`WORKDIR ${PREBUILT_REPO_PATH}`);

  emitStepRuns(lines, recipe, setup);

  lines.push("");
  lines.push(`LABEL valet.prebuild.local="true"`);
  lines.push("");
  return lines.join("\n");
}

export interface GenerateBaseDockerfileOpts {
  baseImage: string;
  /** Setup commands run in order on top of `baseImage` — one `RUN` each. */
  setup: string[];
}

/**
 * Renders a deterministic Dockerfile for a `base` source bake (spec decision
 * 12): `FROM <parent image or stock>` + one `RUN` per setup command. No
 * clone, no git secret, no `WORKDIR` — a base source layers org-wide tools
 * (python3, jq, cc) onto the stock image, it never checks out a repo. Same
 * byte-for-byte determinism as `generateDockerfile` so a golden test can pin
 * it and the identity hash stays stable across processes. */
export function generateBaseDockerfile(opts: GenerateBaseDockerfileOpts): string {
  const { baseImage, setup } = opts;
  const lines: string[] = [];
  lines.push(`FROM ${baseImage}`);
  for (const cmd of setup) {
    lines.push("");
    lines.push(`RUN ${cmd}`);
  }
  const identityHash = createHash("sha256").update(canonicalRecipeJson([], setup)).digest("hex");
  lines.push("");
  lines.push(`LABEL valet.prebuild.identity="${baseImage}|base|${identityHash}"`);
  lines.push("");
  return lines.join("\n");
}
