// @types/node@20 ships no `WebAssembly` types and this package's `lib` is
// ES2022 (no DOM/WebWorker). `WebAssembly` is nonetheless a real Node global,
// used by assets/base.ts to hand PGlite a precompiled module in bundled mode.
// Declare the minimal surface we use. Structurally merges with the same global
// `WebAssembly.Module` that @electric-sql/pglite's own types reference. Remove
// once @types/node is bumped to a version that declares WebAssembly (or DOM
// lib is added).
export {};

declare global {
  namespace WebAssembly {
    // Opaque handle — we only pass it through to PGlite, never introspect it.
    class Module {
      private readonly __brand: "WebAssembly.Module";
    }
    function compile(bytes: ArrayBuffer | ArrayBufferView): Promise<Module>;
  }
}
