// Bundles @valet/api into a single ESM artifact runnable under plain `node`
// (no runtime tsx). Text assets (.md/.sql) are inlined by the inline-assets
// plugin; binary/large assets (web SPA, PGlite wasm) are copied beside the
// bundle by build/copy-assets.mjs.
//
//   pnpm --filter @valet/api run build:bundle
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inlineAssetsPlugin } from "./build/inline-assets.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// ── esbuild externals ─────────────────────────────────────────────────────
// Only packages that cannot be statically bundled (dynamic `require` of
// optional native peers, or driver protocols we never use in the node build).
// Each MUST be documented with the reason it's here.
const external = [
  // `pg` conditionally `require('pg-native')` for the optional libpq-backed
  // Client; it's not installed and we use the pure-JS pg.Pool, so exclude it.
  "pg-native",
  // `pg`'s pure-JS connection layer references `cloudflare:sockets` for the
  // Workers runtime; it's a virtual module that only exists on CF and is
  // guarded behind a runtime check on node.
  "cloudflare:sockets",
  // @firecrawl/pdf-inspector and its platform-specific siblings ship native
  // .node binaries that cannot be bundled by esbuild. The main package
  // dispatches at runtime to the platform-suffixed variant; both the main
  // and each platform sibling must be externalized.
  "@firecrawl/pdf-inspector",
  "@firecrawl/pdf-inspector-linux-x64-gnu",
  "@firecrawl/pdf-inspector-linux-x64-musl",
  "@firecrawl/pdf-inspector-linux-arm64-gnu",
  "@firecrawl/pdf-inspector-linux-arm64-musl",
  "@firecrawl/pdf-inspector-darwin-x64",
  "@firecrawl/pdf-inspector-darwin-arm64",
  "@firecrawl/pdf-inspector-win32-x64-msvc",
  // yauzl is pure JS today but has an optional native accelerator
  // (fd-slicer on some builds). Externalize to avoid bundling issues on
  // future dep bumps if the optional accelerator is ever added as a default.
  "yauzl",
];

await build({
  // Entry is the CLI dispatcher (`valet <subcommand>`); `serve` lazily
  // imports main.ts, every other subcommand lazily imports its command
  // module, so `serve` pays nothing for the client/TUI deps.
  entryPoints: [resolve(here, "src/cli.ts")],
  outfile: resolve(here, "dist/valet-api.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "external",
  // ESM output that bundles CJS deps needs a working top-level `require`
  // (createRequire against the running file). We deliberately do NOT shim
  // `__filename`/`__dirname` here: several bundled ESM source modules (e.g.
  // providers/node.ts) declare their own top-level `const __dirname` from
  // `import.meta.url`, and a banner-level `const __dirname` would be a
  // duplicate top-level declaration ("Identifier '__dirname' has already been
  // declared"). esbuild scopes each CJS dep's own `__dirname` inside its
  // module wrapper, so no global shim is required.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  external,
  plugins: [inlineAssetsPlugin],
  logLevel: "info",
});

console.log("build:bundle -> packages/api/dist/valet-api.mjs");
