import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The state-doc protocol contract, verbatim from protocol/state-doc.md.
 * The API injects it into every dispatch prompt and serves it as the
 * read-only /protocol.md mount in the engagement tree (spec Decision 6:
 * the protocol ships in the plugin, so personas and the server can never
 * see different versions). Read once at first call, then cached.
 */
let cached: string | undefined;

export function protocolMarkdown(): string {
  if (cached === undefined) {
    cached = readFileSync(
      fileURLToPath(new URL("../../protocol/state-doc.md", import.meta.url)),
      "utf8",
    );
  }
  return cached;
}
