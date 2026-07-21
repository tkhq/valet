import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
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
    name: "plugin-github skill (.md)",
    sourceFile: resolve(repoRoot, "packages/plugin-github/src/plugin.ts"),
    literal: "../skills/github.md",
    assetFile: resolve(repoRoot, "packages/plugin-github/skills/github.md"),
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
    expect(() => inlineAssetContent(src, "../skills/does-not-exist.md")).toThrow(/does not exist/);
  });

  it("throws (fail-loud) on a dynamic template-literal asset read", () => {
    const dynamic =
      'const x = readFileSync(fileURLToPath(new URL(`../skills/${file}.md`, import.meta.url)), "utf8");';
    expect(() => transformSource("/fake/plugin.ts", dynamic)).toThrow(/dynamic/i);
  });
});
