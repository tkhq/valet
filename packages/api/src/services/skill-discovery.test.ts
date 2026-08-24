/**
 * The path rules behind whole-repository discovery. Pure input to pure
 * output, so each rule is pinned on its own rather than through a sync.
 *
 * These are the rules a repository's owner runs into: which file is a skill,
 * which directory is skipped and why, and what happens when two files claim
 * one name. `content-sync/skill-collector.test.ts` covers what a sync then
 * DOES with them.
 */
import { describe, expect, it } from "vitest";
import type { SkillTreeEntry } from "./skill-repo-reader.js";
import { discoverFromTree, resolveNameCollisions, treeHoldsSubpath } from "./skill-discovery.js";

function blob(path: string, opts: { mode?: string; sha?: string } = {}): SkillTreeEntry {
  return { path, type: "blob", mode: opts.mode ?? "100644", sha: opts.sha ?? `blob-${path}` };
}

function tree(path: string): SkillTreeEntry {
  return { path, type: "tree", mode: "040000", sha: `tree-${path}` };
}

/** Paths of the accepted candidates, which is what most cases assert. */
function pathsOf(entries: SkillTreeEntry[], subpath = ""): string[] {
  return discoverFromTree(entries, subpath).accepted.map((c) => c.path);
}

describe("discoverFromTree", () => {
  it("names a skill after the directory that holds it, at any depth", () => {
    const found = discoverFromTree(
      [
        tree("04-skills"),
        blob("04-skills/deploy/SKILL.md", { sha: "blob-1" }),
        blob("a/b/c/on-call/SKILL.md"),
      ],
      "",
    );

    expect(found.accepted).toEqual([
      { name: "deploy", path: "04-skills/deploy/SKILL.md", blobSha: "blob-1", kind: "skill" },
      {
        name: "on-call",
        path: "a/b/c/on-call/SKILL.md",
        blobSha: "blob-a/b/c/on-call/SKILL.md",
        kind: "skill",
      },
    ]);
    expect(found.discovered).toBe(2);
    expect(found.excludedCandidates).toEqual([]);
  });

  it("matches SKILL.md exactly, and reads no other markdown file", () => {
    // An agent runtime loads `SKILL.md`. A file that only looks like one is
    // documentation, and importing it would put prose in the skill catalog.
    expect(
      pathsOf([
        blob("deploy/SKILL.md"),
        blob("deploy/skill.md"),
        blob("deploy/README.md"),
        blob("deploy/SKILL.markdown"),
      ]),
    ).toEqual(["deploy/SKILL.md"]);
  });

  it("takes a prompt from a direct child of a prompts directory only", () => {
    const found = discoverFromTree(
      [
        blob("prompts/standup.md"),
        blob("team/prompts/retro.md"),
        // Deeper than a direct child: text a prompt includes.
        blob("prompts/parts/intro.md"),
        // Not markdown.
        blob("prompts/template.txt"),
      ],
      "",
    );

    expect(found.accepted.map((c) => [c.name, c.kind])).toEqual([
      ["retro", "prompt"],
      ["standup", "prompt"],
    ]);
  });

  it("skips a symlinked SKILL.md", () => {
    // The blob behind a symlink holds a path string, not the file it points
    // at, so reading it would import a line of text as a skill.
    expect(pathsOf([blob("deploy/SKILL.md"), blob("mirror/SKILL.md", { mode: "120000" })])).toEqual([
      "deploy/SKILL.md",
    ]);
  });

  it("reports a SKILL.md at the top of the scan instead of dropping it", () => {
    // It has no directory to take a name from. Saying so is what keeps a
    // repository whose only skill file sits at its root from being told that
    // it holds none.
    const found = discoverFromTree([blob("SKILL.md")], "");

    expect(found.accepted).toEqual([]);
    expect(found.warnings.join(" ")).toContain("no directory to name the skill");
  });

  describe("the subdirectory filter", () => {
    it("selects paths under it, matched on whole segments", () => {
      const entries = [
        blob("skills/deploy/SKILL.md"),
        blob("skills-archive/old/SKILL.md"),
        blob("other/escalate/SKILL.md"),
      ];

      expect(pathsOf(entries, "skills")).toEqual(["skills/deploy/SKILL.md"]);
    });

    it("scans the whole repository when it is empty", () => {
      const entries = [blob("skills/deploy/SKILL.md"), blob("other/escalate/SKILL.md")];

      expect(pathsOf(entries, "")).toHaveLength(2);
    });
  });

  describe("directories that are not scanned", () => {
    it("drops a candidate under a dependency tree, build output, or test tree", () => {
      const found = discoverFromTree(
        [
          blob("deploy/SKILL.md"),
          blob("node_modules/@acme/kit/skills/deploy/SKILL.md"),
          blob("vendor/pkg/skills/a/SKILL.md"),
          blob("dist/skills/report/SKILL.md"),
          blob("coverage/skills/b/SKILL.md"),
          blob("src/__tests__/fixtures/broken/SKILL.md"),
          blob("packages/x/testdata/c/SKILL.md"),
        ],
        "",
      );

      expect(found.accepted.map((c) => c.path)).toEqual(["deploy/SKILL.md"]);
      expect(found.discovered).toBe(1);
      expect(found.excludedCandidates).toHaveLength(6);
    });

    it("drops a candidate under a dot-directory, and keeps .claude and .valet", () => {
      const found = discoverFromTree(
        [
          blob(".github/workflows/ci/SKILL.md"),
          blob(".venv/lib/pkg/a/SKILL.md"),
          blob(".claude/skills/triage/SKILL.md"),
          blob(".valet/skills/deploy/SKILL.md"),
        ],
        "",
      );

      expect(found.accepted.map((c) => c.path)).toEqual([
        ".valet/skills/deploy/SKILL.md",
        ".claude/skills/triage/SKILL.md",
      ]);
      expect(found.excludedCandidates.map((c) => c.path)).toEqual([
        ".github/workflows/ci/SKILL.md",
        ".venv/lib/pkg/a/SKILL.md",
      ]);
    });

    it("reads nothing beside a SKILL.md out of .valet", () => {
      // `.valet` already carries three unrelated conventions:
      // `prebuild.yaml` configures the sandbox image, `persona` is written
      // by the runner, and `workflows/` holds workflow files. Opening the
      // directory must not turn any of them into a skill candidate.
      const found = discoverFromTree(
        [
          blob(".valet/prebuild.yaml"),
          blob(".valet/persona"),
          blob(".valet/workflows/nightly.yaml"),
          blob(".valet/skills/deploy/SKILL.md"),
        ],
        "",
      );

      expect(found.accepted.map((c) => c.path)).toEqual([".valet/skills/deploy/SKILL.md"]);
      expect(found.discovered).toBe(1);
      expect(found.excludedCandidates).toEqual([]);
    });

    it("reads a prompts directory under .valet", () => {
      // `/workspace/.valet/prompts/*.md` is already the in-sandbox slash
      // command layout (`engine/command-providers.ts`), so a repository that
      // holds one gets the same prompts through sync.
      const found = discoverFromTree([blob(".valet/prompts/standup.md")], "");

      expect(found.accepted).toEqual([
        {
          name: "standup",
          path: ".valet/prompts/standup.md",
          blobSha: "blob-.valet/prompts/standup.md",
          kind: "prompt",
        },
      ]);
    });

    it("keeps a skill whose OWN directory carries an excluded name", () => {
      // The rule judges ancestors, never the directory the skill is named
      // after. Junk arrives nested — `dist/skills/x/SKILL.md` — while a
      // skill legitimately called `build` sits one level up from nothing.
      expect(pathsOf([blob("build/SKILL.md"), blob("test/SKILL.md")])).toEqual([
        "build/SKILL.md",
        "test/SKILL.md",
      ]);
    });

    it("keeps examples, docs, and specs, which can hold real skills", () => {
      expect(
        pathsOf([
          blob("examples/deploy/SKILL.md"),
          blob("docs/on-call/SKILL.md"),
          blob("specs/review/SKILL.md"),
        ]),
      ).toHaveLength(3);
    });

    it("reaches inside an excluded tree when the subdirectory names it", () => {
      // The escape hatch for over-exclusion. The rules run BELOW the
      // subdirectory, so naming one is a deliberate act.
      const entries = [blob("node_modules/@acme/skills/deploy/SKILL.md")];

      expect(pathsOf(entries, "node_modules/@acme/skills")).toEqual([
        "node_modules/@acme/skills/deploy/SKILL.md",
      ]);
    });

    it("drops the skills an agent runtime downloaded, and keeps the owner's", () => {
      // The layout of a real `.claude` directory. A downloaded plugin ships
      // its author's skills into `plugins/cache` and `plugins/marketplaces`,
      // and those copies outnumber the owner's own. Two of them here share a
      // name with a skill the owner wrote, and the same-kind collision rule
      // imports NEITHER — so failing to exclude them does not merely
      // over-import, it knocks out skills the owner does hold.
      const found = discoverFromTree(
        [
          blob(".claude/skills/configure/SKILL.md"),
          blob(".claude/skills/frontend-design/SKILL.md"),
          blob(".claude/plugins/cache/acme-kit/1.2.0/skills/configure/SKILL.md"),
          blob(".claude/plugins/cache/acme-kit/1.2.0/skills/deploy/SKILL.md"),
          blob(".claude/plugins/marketplaces/hub/plugins/ui/skills/frontend-design/SKILL.md"),
          blob(".claude/external_plugins/other/skills/triage/SKILL.md"),
        ],
        "",
      );

      expect(found.accepted.map((c) => c.path)).toEqual([
        ".claude/skills/configure/SKILL.md",
        ".claude/skills/frontend-design/SKILL.md",
      ]);
      expect(found.warnings).toEqual([]);
      expect(found.excludedCandidates).toHaveLength(4);
    });
  });
});

describe("treeHoldsSubpath", () => {
  // The one thing the tree read does NOT tell the caller for free unless it
  // is asked: whether the configured directory is there at all. Without it,
  // a renamed subdirectory reads as "this repository holds no skill".
  it("is true for the repository root", () => {
    expect(treeHoldsSubpath([], "")).toBe(true);
  });

  it("is true when the directory holds a file", () => {
    expect(treeHoldsSubpath([blob("04-skills/deploy/SKILL.md")], "04-skills")).toBe(true);
  });

  it("is true when the directory is in the tree with no skill under it", () => {
    expect(treeHoldsSubpath([tree("04-skills"), blob("04-skills/README.md")], "04-skills")).toBe(
      true,
    );
  });

  it("is false after the directory is renamed upstream", () => {
    expect(treeHoldsSubpath([blob("skills/deploy/SKILL.md")], "04-skills")).toBe(false);
  });

  it("matches a whole segment, so a longer name is a different directory", () => {
    expect(treeHoldsSubpath([blob("04-skills-archive/deploy/SKILL.md")], "04-skills")).toBe(false);
  });
});

describe("resolveNameCollisions", () => {
  function candidate(name: string, path: string, kind: "skill" | "prompt" = "skill") {
    return { name, path, blobSha: `blob-${path}`, kind };
  }

  it("imports neither of two skills that share a name, and names both paths", () => {
    const resolved = resolveNameCollisions([
      candidate("review", "b/review/SKILL.md"),
      candidate("review", "a/review/SKILL.md"),
      candidate("deploy", "c/deploy/SKILL.md"),
    ]);

    expect(resolved.accepted.map((c) => c.name)).toEqual(["deploy"]);
    // The name is still upstream, so the row that holds it must survive.
    expect([...resolved.reservedNames]).toEqual(["review"]);
    expect(resolved.warnings).toHaveLength(1);
    expect(resolved.warnings[0]).toContain("a/review/SKILL.md and b/review/SKILL.md");
    expect(resolved.warnings[0]).toContain("Two skills cannot share a name");
  });

  it("imports neither of two prompts that share a name", () => {
    const resolved = resolveNameCollisions([
      candidate("retro", "a/prompts/retro.md", "prompt"),
      candidate("retro", "b/prompts/retro.md", "prompt"),
    ]);

    expect(resolved.accepted).toEqual([]);
    expect([...resolved.reservedNames]).toEqual(["retro"]);
    expect(resolved.warnings[0]).toContain("Two prompts cannot share a name");
  });

  it("lets a SKILL.md outrank a prompt of the same name", () => {
    // Ranked by KIND, so which one wins never depends on where either sits.
    // This is the rule that shipped when a skill directory and a prompt file
    // were the only two paths that could produce one name.
    const resolved = resolveNameCollisions([
      candidate("standup", "prompts/standup.md", "prompt"),
      candidate("standup", "standup/SKILL.md"),
    ]);

    expect(resolved.accepted.map((c) => c.path)).toEqual(["standup/SKILL.md"]);
    expect(resolved.reservedNames.size).toBe(0);
    expect(resolved.warnings[0]).toContain("prompts/standup.md collides");
  });

  it("reports one repository the same way every time", () => {
    // Warnings land on a row a person reads. Listing order must not make the
    // same repository produce a different message on the next sweep.
    const first = resolveNameCollisions([
      candidate("b", "x/b/SKILL.md"),
      candidate("b", "y/b/SKILL.md"),
      candidate("a", "y/a/SKILL.md"),
      candidate("a", "x/a/SKILL.md"),
    ]);
    const second = resolveNameCollisions([
      candidate("a", "x/a/SKILL.md"),
      candidate("b", "y/b/SKILL.md"),
      candidate("a", "y/a/SKILL.md"),
      candidate("b", "x/b/SKILL.md"),
    ]);

    expect(first.warnings).toEqual(second.warnings);
    expect(first.warnings[0]).toContain("a: found at x/a/SKILL.md and y/a/SKILL.md");
  });
});
