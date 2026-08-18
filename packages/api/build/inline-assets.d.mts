// Type surface for the plain-JS esbuild plugin (build/inline-assets.mjs), so
// the parity test can import its pure helpers without an implicit `any`.
import type { Plugin } from "esbuild";

/**
 * Resolve `literal` against the directory of `sourceFile` and return the
 * asset's UTF-8 bytes. Throws if the resolved file does not exist.
 */
export function inlineAssetContent(sourceFile: string, literal: string): string;

/**
 * Rewrite a source file's text, inlining every matching `.md`/`.sql` read as a
 * JSON string literal. Throws on a dynamic (template-literal) asset read, and
 * on an asset read whose call shape it cannot rewrite.
 */
export function transformSource(sourceFile: string, source: string): string;

/** The esbuild plugin object. */
export const inlineAssetsPlugin: Plugin;
