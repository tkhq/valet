/**
 * Pure desired-sandbox-spec computation (sandbox-reconciliation plan, Task 1).
 * No I/O — takes a `ResolveSnapshot` and returns a `SandboxSpec` describing
 * which image and prep steps the sandbox should have. Later tasks diff this
 * against observed sandbox state to drive reconciliation.
 *
 * `specHash` produces a stable SHA-256 over canonical JSON so callers can
 * detect spec changes with a single string comparison.
 */
import { createHash } from "node:crypto";
import type { RepoBinding } from "../wire/types.js";
import type { RecipeStep } from "../prebuilds/recipe.js";
import { gitCredentialHelperScript, ghWrapperScript } from "./git-credential-helper.js";
import { secretsCliScript } from "./secrets-cli-script.js";

// Increment when the prep logic changes in a way that requires re-running all
// steps — changing this value intentionally invalidates every cached hash.
export const PREP_VERSION = 1;

// ── Public types ──────────────────────────────────────────────────────────

export interface ResolveSnapshot {
  /** Sandbox API base URL embedded in the credential shim scripts. */
  apiUrl: string;
  /** Default stock image (resolveDefaultImage result). */
  stockImage: string;
  /** Per-repo baked image when a fresh prebuild is available; null otherwise. */
  repoBake: {
    imageRef: string;
    bakedSha: string;
    recipe: RecipeStep[];
    bakeId: string;
  } | null;
  /** Org base bake image ref — phase 4 feature, null until then. */
  baseBakeRef: string | null;
  /**
   * Repos bound to this session in position order. `targetDir` is supplied
   * by the caller (Task 14 adds persistence); `RepoBinding` does not carry
   * it yet, so the intersection type makes the field explicit.
   */
  repos: Array<RepoBinding & { targetDir: string }>;
  userName?: string;
  userEmail?: string;
}

export interface StepSpec {
  id: string;
  hash: string;
  critical: boolean;
}

export interface SandboxSpec {
  image: string;
  steps: StepSpec[];
}

// ── Hashing helpers ───────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// ── computeSpec ───────────────────────────────────────────────────────────

/**
 * Computes the desired `SandboxSpec` from a resolved snapshot.
 *
 * Image resolution order: `repoBake.imageRef` → `baseBakeRef` → `stockImage`.
 *
 * Steps, in order:
 * 1. `credential-scripts` — covers the generated shim scripts + PREP_VERSION.
 * 2. `git-identity` — covers userName + userEmail + PREP_VERSION.
 * 3. One `clone:<fullName>` per binding — covers configuration only, never
 *    the head SHA (spec decision 2: world-state excluded from the spec hash).
 */
export function computeSpec(snap: ResolveSnapshot): SandboxSpec {
  const image = snap.repoBake?.imageRef ?? snap.baseBakeRef ?? snap.stockImage;

  const steps: StepSpec[] = [];

  // Step 1: credential-scripts
  const credInput =
    gitCredentialHelperScript(snap.apiUrl) +
    ghWrapperScript(snap.apiUrl) +
    // `valet-secrets` is installed by the same step, so it belongs in the
    // same hash: without it, editing the script would never re-install on a
    // sandbox that already ran prep.
    secretsCliScript(snap.apiUrl) +
    String(PREP_VERSION);
  steps.push({ id: "credential-scripts", hash: sha256(credInput), critical: false });

  // Step 2: git-identity
  const identityInput = `${snap.userName ?? ""}|${snap.userEmail ?? ""}|${PREP_VERSION}`;
  steps.push({ id: "git-identity", hash: sha256(identityInput), critical: false });

  // Step 3: one clone step per binding
  for (const binding of snap.repos) {
    const { fullName, cloneUrl, ref, auth, targetDir } = binding;
    const cloneInput = `${fullName}|${cloneUrl}|${ref ?? ""}|${auth ?? ""}|${targetDir}|${PREP_VERSION}`;
    steps.push({ id: `clone:${fullName}`, hash: sha256(cloneInput), critical: true });
  }

  return { image, steps };
}

// ── specHash ──────────────────────────────────────────────────────────────

/**
 * Produces a SHA-256 hex digest over the canonical JSON of a `SandboxSpec`.
 *
 * Canonical JSON: image first, then steps in array order with each step's
 * keys in fixed order (id, hash, critical). Never relies on object key
 * insertion order from a spread.
 */
export function specHash(spec: SandboxSpec): string {
  const canonical = JSON.stringify({
    image: spec.image,
    steps: spec.steps.map((s) => ({ id: s.id, hash: s.hash, critical: s.critical })),
  });
  return sha256(canonical);
}
