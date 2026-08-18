// esbuild plugin: inline text assets (.md / .sql) that are read at module
// load time via `readFileSync(new URL("<lit>", import.meta.url), "utf8")` or
// `readFileSync(fileURLToPath(new URL("<lit>", import.meta.url)), "utf8")`.
//
// Why: the single-file bundle collapses every module's `import.meta.url` to
// the bundle's OWN location, so those relative reads would resolve to the
// wrong path at runtime. Inlining the actual bytes at build time makes the
// read a no-op string literal that needs no filesystem lookup.
//
// Scope: only the two exact call shapes above, and only when the literal ends
// in `.md` or `.sql`. Every other `readFileSync` / `new URL` is left
// untouched. If a matching call's literal cannot be statically resolved to an
// existing `.md`/`.sql` file, the build THROWS — we never silently ship a
// broken read.
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, extname } from "node:path";

// Matches BOTH shapes in one pattern (the optional `fileURLToPath(` wrapper),
// capturing the string-literal path. The literal group only accepts single-
// or double-quoted strings — a backtick/template literal (dynamic path) will
// NOT match here and is caught by the fail-loud detector below instead.
//
// Whitespace-tolerant (`\s*`) so multi-line source (e.g. the google-calendar
// and sandbox-tunnels plugins) still matches, and tolerant of a TRAILING
// COMMA after the encoding. That comma is not cosmetic: a multi-line call
// gets one from the formatter, so the source form of a plugin reads
// `"utf8",\n)` while the tsc-emitted one-line form reads `"utf8")`. While
// every plugin's `./plugin` export pointed at `dist`, only the second shape
// ever reached this plugin. Now that every workspace package resolves from
// source, the first shape does, and a regex that rejected it left a live
// filesystem read in the bundle.
const READ_CALL =
  /readFileSync\(\s*(?:fileURLToPath\(\s*)?new URL\(\s*(['"])((?:[^'"\\]|\\.)*)\1\s*,\s*import\.meta\.url\s*\)\s*(?:\)\s*)?,\s*(['"])utf-?8\3\s*,?\s*\)/g;

// Fail-loud detector: any `readFileSync( ... new URL( <template-literal> ,
// import.meta.url ... )` whose path is a backtick template (dynamic) can't be
// statically resolved — throw rather than let a broken read slip through.
const DYNAMIC_READ =
  /readFileSync\(\s*(?:fileURLToPath\(\s*)?new URL\(\s*`[^`]*`\s*,\s*import\.meta\.url/g;

// Same head as READ_CALL, with NO tail: it matches an asset read whatever
// follows the path. Used on the OUTPUT to catch a read that READ_CALL did
// not rewrite — a call written in a shape the tail does not cover, such as
// `{ encoding: "utf8" }`. Such a read resolves against the bundle's own
// directory at runtime and the server dies on its first boot, so the build
// stops here instead.
const SURVIVING_READ =
  /readFileSync\(\s*(?:fileURLToPath\(\s*)?new URL\(\s*(['"])((?:[^'"\\]|\\.)*)\1\s*,\s*import\.meta\.url/g;

const ASSET_EXTS = new Set([".md", ".sql"]);

/**
 * Pure helper (exported for the parity unit test): given the absolute path of
 * the SOURCE file containing the call and the raw literal from the `new URL`
 * first argument, resolve the asset against the source file's own directory
 * and return its bytes as a UTF-8 string. Throws if the resolved file does not
 * exist.
 */
export function inlineAssetContent(sourceFile, literal) {
  const assetPath = resolve(dirname(sourceFile), literal);
  if (!existsSync(assetPath)) {
    throw new Error(
      `inline-assets: ${sourceFile} reads "${literal}" (resolved ${assetPath}) but that file does not exist`,
    );
  }
  return readFileSync(assetPath, "utf8");
}

/**
 * Transform a single source file's text, inlining every matching `.md`/`.sql`
 * read. Returns the rewritten source. Exported for unit testing.
 */
export function transformSource(sourceFile, source) {
  // Fail loud on dynamic (template-literal) reads: they can't be inlined and
  // would resolve to the bundle's own dir at runtime — a silent broken read.
  DYNAMIC_READ.lastIndex = 0;
  const dyn = DYNAMIC_READ.exec(source);
  if (dyn) {
    throw new Error(
      `inline-assets: ${sourceFile} contains a dynamic \`new URL(\`...\`, import.meta.url)\` ` +
        `readFileSync that cannot be statically inlined. Rewrite it to use a static string literal.`,
    );
  }

  const result = source.replace(READ_CALL, (match, _q1, literal) => {
    if (!ASSET_EXTS.has(extname(literal))) {
      // Not a text asset we own (e.g. a .json/.wasm read handled elsewhere) —
      // leave the call exactly as-is.
      return match;
    }
    const content = inlineAssetContent(sourceFile, literal);
    return JSON.stringify(content);
  });

  // Fail loud on an asset read this pass did NOT rewrite. The inlined bytes
  // cannot trip this: `JSON.stringify` escapes the quotes inside them, so a
  // SKILL.md that documents the pattern reads as `new URL(\"...` here.
  SURVIVING_READ.lastIndex = 0;
  let survivor;
  while ((survivor = SURVIVING_READ.exec(result)) !== null) {
    const literal = survivor[2];
    if (!ASSET_EXTS.has(extname(literal))) continue;
    throw new Error(
      `inline-assets: ${sourceFile} reads "${literal}" through a readFileSync shape this plugin does not ` +
        `rewrite, so the bundle would read it from disk at runtime and fail. Write the call as ` +
        `readFileSync(fileURLToPath(new URL("${literal}", import.meta.url)), "utf8"), or widen READ_CALL.`,
    );
  }

  return result;
}

/** The esbuild plugin object. */
export const inlineAssetsPlugin = {
  name: "inline-assets",
  setup(build) {
    // Match .ts source (store-postgres/api/engine resolve to src) AND .js
    // (workspace plugin `./plugin` exports resolve to their compiled dist).
    build.onLoad({ filter: /packages\/.*\.(ts|js)$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      // Cheap pre-check: skip files with no asset read at all.
      if (!source.includes("import.meta.url") || !source.includes("readFileSync")) {
        return null;
      }
      const contents = transformSource(args.path, source);
      if (contents === source) return null;
      return { contents, loader: args.path.endsWith(".ts") ? "ts" : "js" };
    });
  },
};
