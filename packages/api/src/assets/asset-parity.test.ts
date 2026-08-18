import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
// The plugin is plain JS (no TS types) — resolved relative to this test file.
import { inlineAssetContent, transformSource } from "../../build/inline-assets.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * Each case names a SOURCE file that contains a
 * `readFileSync(...new URL("<literal>", import.meta.url)...)` asset read and
 * the literal it passes. Parity = the bytes the inline plugin would embed must
 * byte-equal the asset file on disk.
 */
const CASES = [
  {
    name: "plugin-github SKILL.md",
    sourceFile: resolve(repoRoot, "packages/plugin-github/src/plugin.ts"),
    literal: "../skills/github/SKILL.md",
    assetFile: resolve(repoRoot, "packages/plugin-github/skills/github/SKILL.md"),
  },
  {
    // A MULTI-LINE call, whose formatter-added trailing comma after "utf8"
    // the matcher once rejected. While every plugin's `./plugin` export
    // pointed at `dist`, only tsc's one-line output reached the inliner and
    // this shape never appeared. Now that packages resolve from source, it
    // does — and an unmatched read here means the bundled server dies on its
    // first boot, reading a SKILL.md that is not beside the bundle.
    name: "plugin-google-calendar SKILL.md (multi-line call, trailing comma)",
    sourceFile: resolve(repoRoot, "packages/plugin-google-calendar/src/plugin.ts"),
    literal: "../skills/google-calendar/SKILL.md",
    assetFile: resolve(repoRoot, "packages/plugin-google-calendar/skills/google-calendar/SKILL.md"),
  },
  {
    name: "plugin-sandbox-tunnels SKILL.md (multi-line call, trailing comma)",
    sourceFile: resolve(repoRoot, "packages/plugin-sandbox-tunnels/src/plugin.ts"),
    literal: "../skills/sandbox-tunnels/SKILL.md",
    assetFile: resolve(repoRoot, "packages/plugin-sandbox-tunnels/skills/sandbox-tunnels/SKILL.md"),
  },
  {
    name: "store-postgres engine migration (.sql)",
    sourceFile: resolve(repoRoot, "packages/store-postgres/src/migrate.ts"),
    literal: "../migrations/pg/0000_engine.sql",
    assetFile: resolve(repoRoot, "packages/store-postgres/migrations/pg/0000_engine.sql"),
  },
  {
    name: "api app migration (.sql)",
    sourceFile: resolve(repoRoot, "packages/api/src/lib/drizzle.ts"),
    literal: "../../migrations/pg/0000_app.sql",
    assetFile: resolve(repoRoot, "packages/api/migrations/pg/0000_app.sql"),
  },
];

describe("inline-assets parity", () => {
  for (const c of CASES) {
    it(`inlines ${c.name} byte-for-byte`, () => {
      const expected = readFileSync(c.assetFile, "utf8");
      // Non-trivial content, not an empty/placeholder file.
      expect(expected.length).toBeGreaterThan(100);

      const inlined = inlineAssetContent(c.sourceFile, c.literal);
      expect(inlined).toBe(expected);

      // And the full source transform embeds a JSON string literal whose
      // parsed value byte-equals the file — the exact thing the bundle ships.
      const src = readFileSync(c.sourceFile, "utf8");
      const out = transformSource(c.sourceFile, src);
      // The read expression is gone (only its inlined bytes remain). Note the
      // JSDoc above these calls may still mention `import.meta.url` in prose —
      // we assert the CALL literal is replaced, not that the phrase vanishes.
      expect(out).not.toContain(`new URL("${c.literal}"`);
      expect(out).toContain(JSON.stringify(expected));
    });
  }

  it("throws (fail-loud) when a static literal resolves to a missing file", () => {
    const src = resolve(repoRoot, "packages/plugin-github/src/plugin.ts");
    expect(() => inlineAssetContent(src, "../skills/does-not-exist/SKILL.md")).toThrow(
      /does not exist/,
    );
  });

  it("throws (fail-loud) on a dynamic template-literal asset read", () => {
    const dynamic =
      'const x = readFileSync(fileURLToPath(new URL(`../skills/${file}/SKILL.md`, import.meta.url)), "utf8");';
    expect(() => transformSource("/fake/plugin.ts", dynamic)).toThrow(/dynamic/i);
  });

  it("throws (fail-loud) on an asset read shape it cannot rewrite", () => {
    // The failure this closes is silent by nature: an unrewritten read builds
    // and only dies when somebody boots the bundle. The build must stop
    // instead, whatever new call shape a future author writes.
    const unsupported =
      'const x = readFileSync(new URL("../skills/github/SKILL.md", import.meta.url), { encoding: "utf8" });';
    const src = resolve(repoRoot, "packages/plugin-github/src/plugin.ts");
    expect(() => transformSource(src, unsupported)).toThrow(/does not rewrite/i);
  });

  it("does not mistake inlined asset BYTES for an un-inlined read", () => {
    // A SKILL.md that DOCUMENTS the pattern must not trip the detector above,
    // or the build stops on a file that is perfectly correct. The inlined
    // bytes arrive JSON-escaped, so their quotes carry backslashes and the
    // detector cannot match them.
    const dir = mkdtempSync(join(tmpdir(), "valet-inline-assets-"));
    try {
      writeFileSync(
        join(dir, "doc.md"),
        'Read the skill with readFileSync(fileURLToPath(new URL("./doc.md", import.meta.url)), "utf8").\n',
      );
      const source = 'const doc = readFileSync(fileURLToPath(new URL("./doc.md", import.meta.url)), "utf8");';
      const out = transformSource(join(dir, "plugin.ts"), source);
      expect(out).toContain(String.raw`new URL(\"./doc.md\"`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
