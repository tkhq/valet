/**
 * The CLI/product version. Kept as a literal in sync with
 * `packages/api/package.json` `version` (pre-1.0 this is fine; a later task
 * can bake it from package.json at build time if we want). Consumed by the
 * dispatcher's `--version` handler and any command that reports the version.
 */
export const VALET_VERSION = "0.0.1";
