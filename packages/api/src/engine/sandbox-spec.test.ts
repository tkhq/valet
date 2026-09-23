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
    sizeBytes: 3_000_000_000,
  },
  baseBakeRef: "ghcr.io/valet/base-bake:v1",
  baseBakeSizeBytes: 2_000_000_000,
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

// ── Image size (workspace floor input, TKAI-538) ────────────────────────────

describe("imageSizeBytes", () => {
  it("reports the repo bake size when the repo bake is selected", () => {
    expect(computeSpec(snapWithRepoBake).imageSizeBytes).toBe(3_000_000_000);
  });

  it("reports the base bake size when the base image is selected", () => {
    expect(computeSpec(snapWithBaseBake).imageSizeBytes).toBe(2_000_000_000);
  });

  it("is null for the stock image, which has no bake row", () => {
    expect(computeSpec(snapWithStockOnly).imageSizeBytes).toBeNull();
  });

  it("is null when the selected repo bake has no recorded size", () => {
    const snap: ResolveSnapshot = {
      ...snapWithRepoBake,
      repoBake: { ...snapWithRepoBake.repoBake!, sizeBytes: null },
    };
    expect(computeSpec(snap).imageSizeBytes).toBeNull();
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

  it("credential-scripts, git-identity, and clone steps are critical", () => {
    const spec = computeSpec(snapWithRepoBake);
    const byId = Object.fromEntries(spec.steps.map((s) => [s.id, s]));
    expect(byId["credential-scripts"]!.critical).toBe(true);
    expect(byId["git-identity"]!.critical).toBe(true);
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
    expect(specHash(spec)).toMatchInlineSnapshot(`"9f93063bb2d4adcdcdc05a79dcc7c1740b90d4bf9855b60cd78b22c74e3e1c6e"`);
  });

  it("baseBake image spec has expected specHash", () => {
    const spec = computeSpec(snapWithBaseBake);
    expect(specHash(spec)).toMatchInlineSnapshot(`"6cf7b9f8ad1f90450c9bc9047cfe7fa4431c4b11c1a174f3fd1e7d6ae65c6124"`);
  });

  it("stock image spec has expected specHash", () => {
    const spec = computeSpec(snapWithStockOnly);
    expect(specHash(spec)).toMatchInlineSnapshot(`"c70e0128e0fd76bfd34a88f9e6c8203fcf4a4bd7c8f71f14caaa7ca924db5dcf"`);
  });
});

describe("resource opinion hashing", () => {
  const spec = computeSpec(snapWithRepoBake);

  it("preserves the existing hash when no resource opinion exists", () => {
    expect(specHash(spec, undefined)).toBe(specHash(spec));
    expect(specHash(spec)).toBe("9f93063bb2d4adcdcdc05a79dcc7c1740b90d4bf9855b60cd78b22c74e3e1c6e");
  });

  it("uses fixed cpu then memory order independent of insertion order", () => {
    expect(specHash(spec, { cpu: 4, memory: "8Gi" })).toBe(
      specHash(spec, { memory: "8Gi", cpu: 4 }),
    );
  });

  it.each([
    ["empty", {}],
    ["cpu", { cpu: 4 }],
    ["memory", { memory: "8Gi" }],
    ["cpu and memory", { cpu: 4, memory: "8Gi" }],
  ])("distinguishes a %s opinion from no opinion", (_label, resources) => {
    expect(specHash(spec, resources)).not.toBe(specHash(spec));
  });

  it("changes when either authoritative resource value changes", () => {
    const base = specHash(spec, { cpu: 4, memory: "8Gi" });
    expect(specHash(spec, { cpu: 2, memory: "8Gi" })).not.toBe(base);
    expect(specHash(spec, { cpu: 4, memory: "4Gi" })).not.toBe(base);
  });

  it("changes when resource field authority changes", () => {
    const base = specHash(spec, { cpu: 2 });
    expect(specHash(spec, { cpu: 2 }, ["memory"])).not.toBe(base);
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

  it("changes wrapper and hook steps when an attribution generation changes", () => {
    const attributed = { ...snapWithRepoBake, gitAttribution: { generation: 1, mode: "valet_app_signed", coAuthoredBy: true, correlationTrailers: true, settingsFingerprint: "one", counterpartName: "Ada", counterpartEmail: "ada@example.com", valetName: "Valet", valetEmail: "valet@example.com" } };
    const first = Object.fromEntries(computeSpec(attributed).steps.map((step) => [step.id, step.hash]));
    const second = Object.fromEntries(computeSpec({ ...attributed, gitAttribution: { ...attributed.gitAttribution, generation: 2, mode: "valet_unsigned", correlationTrailers: false } }).steps.map((step) => [step.id, step.hash]));
    expect(second["credential-scripts"]).not.toBe(first["credential-scripts"]);
    expect(second["clone:acme/widget"]).not.toBe(first["clone:acme/widget"]);
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

  it("a new content-addressed image ref changes the desired spec", () => {
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
    expect(diffImage.image).toBe("ghcr.io/acme/widget-bake:xyz");
    expect(specHash(diffImage)).not.toBe(specHash(base));
  });
});
