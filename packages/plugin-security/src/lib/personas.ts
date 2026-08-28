import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The extensible persona registry (dynamic-config M-F1, spec §Dynamic
 * configuration). A persona is the role a cell-claimed child session runs
 * under: an id, a display label, and the role markdown the host attaches.
 *
 * Bundled personas ship here (for now: `code-review`). A repo may also define
 * its own persona in `.valet/security.yml`'s `personas` map (repo wins); those
 * are loaded from the clone at attach time, not from this registry. A plan
 * cell's `persona` must name a BUNDLED id or a repo-declared key —
 * `parseSecurityConfig` checks both, and `parsePlan` checks the bundled set
 * through `KNOWN_PERSONAS` (which equals `bundledPersonaIds()`).
 */
export interface SecurityPersona {
  /** The persona id a plan cell names (matches the RoleSpec name). */
  id: string;
  /** Short display label for the hub/panel. */
  label: string;
  /** The role markdown the host loads with loadRoleFromMarkdown. */
  roleMarkdown: string;
}

/** The v1 persona id. Kept as a named export for call sites that reference it
 * directly (presets build every cell with this persona). */
export const CODE_REVIEW_PERSONA = "code-review";

// Static `new URL(<literal>, import.meta.url)` per persona — the api bundle's
// inline-assets step can only inline a STATIC string literal, not a
// `../../personas/${id}.md` template (that read is dynamic and breaks the
// bundle). One literal per bundled persona keeps every read inlinable. The
// path resolves from dist/lib/personas.js back to the package's personas/ dir.
const CODE_REVIEW_URL = new URL("../../personas/code-review.md", import.meta.url);

function readPersonaMarkdown(url: URL): string {
  return readFileSync(fileURLToPath(url), "utf8");
}

/** Every bundled persona. Repo-defined personas are NOT in this list. */
export const BUNDLED_PERSONAS: readonly SecurityPersona[] = [
  {
    id: CODE_REVIEW_PERSONA,
    label: "Code review",
    roleMarkdown: readPersonaMarkdown(CODE_REVIEW_URL),
  },
];

/** The bundled persona ids, in registry order. `KNOWN_PERSONAS` equals this,
 * so `parsePlan`'s persona check gates against the registry. */
export function bundledPersonaIds(): string[] {
  return BUNDLED_PERSONAS.map((p) => p.id);
}

/** The bundled persona for an id, or null when the id is repo-defined or
 * unknown. */
export function bundledPersona(id: string): SecurityPersona | null {
  return BUNDLED_PERSONAS.find((p) => p.id === id) ?? null;
}
