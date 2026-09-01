/**
 * Golden tests for sandbox-spec.ts — determinism and hash-sensitivity
 * assertions. See the sandbox-reconciliation plan, Task 1.
 *
 * Hash strings are pre-computed from the implementation and pinned here so
 * FUTURE changes to inputs visibly break exactly one expected hash.
 */
import { describe, expect, it } from "vitest";
import { computeSpec, specHash } from "./sandbox-spec.js";
import type { ResolveSnapshot } from "./sandbox-spec.js";
import type { RepoBinding } from "../wire/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

/** A minimal binding with all required fields plus targetDir. */
function makeBinding(overrides?: Partial<RepoBinding & { targetDir: string }>): RepoBinding & {
  targetDir: string;
} {
  return {
    fullName: "acme/widget",
    cloneUrl: "https://github.com/acme/widget.git",
    ref: "main",
    auth: "auto",
    targetDir: "/workspace/widget",
    ...overrides,
  };
}

/** A snapshot with repoBake set (highest-priority image source). */
const snapWithRepoBake: ResolveSnapshot = {
  apiUrl: "https://api.example.com",
  stockImage: "ghcr.io/valet/sandbox:latest",
  repoBake: {
    imageRef: "ghcr.io/acme/widget-bake:abc123",
    bakedSha: "deadbeef",
    recipe: [],
    bakeId: "bake-1",
  },
  baseBakeRef: "ghcr.io/valet/base-bake:v1",
  repos: [makeBinding()],
  userName: "Alice",
  userEmail: "alice@example.com",
};

/** A snapshot with no repoBake but a baseBakeRef (second priority). */
const snapWithBaseBake: ResolveSnapshot = {
  ...snapWithRepoBake,
  repoBake: null,
};

/** A snapshot with neither repoBake nor baseBakeRef (stock fallback). */
const snapWithStockOnly: ResolveSnapshot = {
  ...snapWithRepoBake,
  repoBake: null,
  baseBakeRef: null,
};

// ── Image resolution order ─────────────────────────────────────────────────

describe("image resolution", () => {
  it("uses repoBake.imageRef when present", () => {
    const spec = computeSpec(snapWithRepoBake);
    expect(spec.image).toBe("ghcr.io/acme/widget-bake:abc123");
  });

  it("falls back to baseBakeRef when repoBake is null", () => {
    const spec = computeSpec(snapWithBaseBake);
    expect(spec.image).toBe("ghcr.io/valet/base-bake:v1");
  });

  it("falls back to stockImage when both bake refs are null", () => {
    const spec = computeSpec(snapWithStockOnly);
    expect(spec.image).toBe("ghcr.io/valet/sandbox:latest");
  });
});

// ── Step structure ─────────────────────────────────────────────────────────

describe("step structure", () => {
  it("emits credential-scripts, git-identity, and one clone step", () => {
    const spec = computeSpec(snapWithRepoBake);
    expect(spec.steps.map((s) => s.id)).toEqual([
      "credential-scripts",
      "git-identity",
      "clone:acme/widget",
    ]);
  });

  it("credential-scripts and git-identity are not critical; clone steps are", () => {
    const spec = computeSpec(snapWithRepoBake);
    const byId = Object.fromEntries(spec.steps.map((s) => [s.id, s]));
    expect(byId["credential-scripts"]!.critical).toBe(false);
    expect(byId["git-identity"]!.critical).toBe(false);
    expect(byId["clone:acme/widget"]!.critical).toBe(true);
  });

  it("emits one clone step per binding in position order", () => {
    const snap: ResolveSnapshot = {
      ...snapWithRepoBake,
      repos: [
        makeBinding({ fullName: "acme/widget", targetDir: "/workspace/widget" }),
        makeBinding({ fullName: "acme/core", cloneUrl: "https://github.com/acme/core.git", targetDir: "/workspace/core" }),
      ],
    };
    const spec = computeSpec(snap);
    expect(spec.steps.map((s) => s.id)).toEqual([
      "credential-scripts",
      "git-identity",
      "clone:acme/widget",
      "clone:acme/core",
    ]);
  });
});

// ── Determinism ────────────────────────────────────────────────────────────

describe("determinism", () => {
  it("same snapshot → identical specHash twice", () => {
    const h1 = specHash(computeSpec(snapWithRepoBake));
    const h2 = specHash(computeSpec(snapWithRepoBake));
    expect(h1).toBe(h2);
  });

  it("specHash is a 64-char hex string", () => {
    const h = specHash(computeSpec(snapWithRepoBake));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── Golden hashes (pinned — any change to inputs or logic breaks these) ────
//
// To repin: delete the expected string, run the test, and paste the output.

describe("golden hashes", () => {
  it("repoBake image spec has expected specHash", () => {
    const spec = computeSpec(snapWithRepoBake);
    expect(specHash(spec)).toMatchInlineSnapshot(`"44e5f61124e781ee03e022a9b5d7080050555d9d852adb56feb792251e4c60de"`);
  });

  it("baseBake image spec has expected specHash", () => {
    const spec = computeSpec(snapWithBaseBake);
    expect(specHash(spec)).toMatchInlineSnapshot(`"a3b7a18d9ee726e0336d4c827320f3c7010567b8684ae757e1070b274fa00922"`);
  });

  it("stock image spec has expected specHash", () => {
    const spec = computeSpec(snapWithStockOnly);
    expect(specHash(spec)).toMatchInlineSnapshot(`"00211603431feaac48e7341c0b4b3af1456242d1289e9d7d8d5130a7a4035954"`);
  });
});

// ── Hash sensitivity matrix ────────────────────────────────────────────────

describe("hash sensitivity", () => {
  const base = computeSpec(snapWithRepoBake);
  const baseSteps = Object.fromEntries(base.steps.map((s) => [s.id, s.hash]));

  it("changing apiUrl changes only credential-scripts hash", () => {
    const changed = computeSpec({ ...snapWithRepoBake, apiUrl: "https://other.example.com" });
    const changedSteps = Object.fromEntries(changed.steps.map((s) => [s.id, s.hash]));

    expect(changedSteps["credential-scripts"]).not.toBe(baseSteps["credential-scripts"]);
    expect(changedSteps["git-identity"]).toBe(baseSteps["git-identity"]);
    expect(changedSteps["clone:acme/widget"]).toBe(baseSteps["clone:acme/widget"]);
  });

  it("changing userEmail changes only git-identity hash", () => {
    const changed = computeSpec({ ...snapWithRepoBake, userEmail: "bob@example.com" });
    const changedSteps = Object.fromEntries(changed.steps.map((s) => [s.id, s.hash]));

    expect(changedSteps["credential-scripts"]).toBe(baseSteps["credential-scripts"]);
    expect(changedSteps["git-identity"]).not.toBe(baseSteps["git-identity"]);
    expect(changedSteps["clone:acme/widget"]).toBe(baseSteps["clone:acme/widget"]);
  });

  it("changing a binding ref changes only its clone step hash", () => {
    const changed = computeSpec({
      ...snapWithRepoBake,
      repos: [makeBinding({ ref: "feat/my-branch" })],
    });
    const changedSteps = Object.fromEntries(changed.steps.map((s) => [s.id, s.hash]));

    expect(changedSteps["credential-scripts"]).toBe(baseSteps["credential-scripts"]);
    expect(changedSteps["git-identity"]).toBe(baseSteps["git-identity"]);
    expect(changedSteps["clone:acme/widget"]).not.toBe(baseSteps["clone:acme/widget"]);
  });

  it("changing only bakedSha (world-state) does not change any step hash", () => {
    const changed = computeSpec({
      ...snapWithRepoBake,
      repoBake: { ...snapWithRepoBake.repoBake!, bakedSha: "newsha999" },
    });
    const changedSteps = Object.fromEntries(changed.steps.map((s) => [s.id, s.hash]));

    expect(changedSteps["credential-scripts"]).toBe(baseSteps["credential-scripts"]);
    expect(changedSteps["git-identity"]).toBe(baseSteps["git-identity"]);
    expect(changedSteps["clone:acme/widget"]).toBe(baseSteps["clone:acme/widget"]);
  });

  it("changing bakedSha changes specHash only when imageRef is different", () => {
    // Same imageRef, different bakedSha → step hashes identical → same specHash.
    const sameSha = computeSpec({
      ...snapWithRepoBake,
      repoBake: { ...snapWithRepoBake.repoBake!, bakedSha: "different-sha" },
    });
    expect(specHash(sameSha)).toBe(specHash(base));

    // Different imageRef → image changes → specHash differs.
    const diffImage = computeSpec({
      ...snapWithRepoBake,
      repoBake: { ...snapWithRepoBake.repoBake!, imageRef: "ghcr.io/acme/widget-bake:xyz" },
    });
    expect(specHash(diffImage)).not.toBe(specHash(base));
  });
});
