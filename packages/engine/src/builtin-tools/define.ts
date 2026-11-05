import type { TSchema } from "typebox";
import type { ToolDef } from "../types.js";

/**
 * Helper that preserves the schema's static type through the ToolDef so
 * `args` in `execute` is typed precisely instead of `unknown`.
 *
 * Lives in its own file (not builtin-tools/index.ts) so sibling tool
 * modules — e.g. wakeups.ts — can import it without creating an import
 * cycle back through index.ts.
 */
export function defineTool<T extends TSchema>(def: ToolDef<T>): ToolDef<T> {
  return def;
}
