import { readFileSync } from "node:fs";

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

/** The architect persona id: plans a phase, seeds a falsifiable checklist,
 * declares coverage, and does NOT report findings (M-P2b). The plan-cell of a
 * triad runs under this persona. */
export const ARCHITECT_PERSONA = "architect";

/** The verifier persona id: audits a phase's worker, re-derives each finding's
 * dataflow, audits coverage, and emits a PASS/CONDITIONAL/FAIL verdict (M-P2b).
 * The verify-cell of a triad runs under this persona with `review: true`, so it
 * can refute a finding it disproves. */
export const VERIFIER_PERSONA = "verifier";

/** The threat-model persona id: enumerates threats over STRIDE and the loaded
 * threat categories, maps each to a recon entry point or trust boundary, and
 * reports a confirmed weakness as a finding (M-P2c). Source/config-only. */
export const THREAT_MODEL_PERSONA = "threat-model";

/** The attack-tree persona id: composes attack chains from confirmed findings
 * and the threat model, surfacing multi-step paths a single-finding view misses
 * (M-P2c). Runs late, over the other phases. Source/config-only. */
export const ATTACK_TREE_PERSONA = "attack-tree";

/** The sast persona id: a scanner-heavy static-analysis sweep — the pre-baked
 * scanners plus per-language grep packs, triaged into evidence-backed findings
 * with coverage per rule pack (M-P2c). Distinct from code-review's human-style
 * reading. Source/config-only. */
export const SAST_PERSONA = "sast";

// The api bundle's inline-assets step only inlines a `readFileSync(new
// URL("<literal>", import.meta.url), "utf8")` whose literal is AT the call
// site — a URL held in a const/variable is silently NOT inlined (a runtime
// read that fails in the single-file bundle). So each bundled persona reads
// its markdown by its own literal call. Path resolves from dist/lib/ back to
// the package's personas/ dir.
export const BUNDLED_PERSONAS: readonly SecurityPersona[] = [
  {
    id: CODE_REVIEW_PERSONA,
    label: "Code review",
    roleMarkdown: readFileSync(new URL("../../personas/code-review.md", import.meta.url), "utf8"),
  },
  {
    id: ARCHITECT_PERSONA,
    label: "Architect",
    roleMarkdown: readFileSync(new URL("../../personas/architect.md", import.meta.url), "utf8"),
  },
  {
    id: VERIFIER_PERSONA,
    label: "Verifier",
    roleMarkdown: readFileSync(new URL("../../personas/verifier.md", import.meta.url), "utf8"),
  },
  {
    id: THREAT_MODEL_PERSONA,
    label: "Threat model",
    roleMarkdown: readFileSync(new URL("../../personas/threat-model.md", import.meta.url), "utf8"),
  },
  {
    id: ATTACK_TREE_PERSONA,
    label: "Attack tree",
    roleMarkdown: readFileSync(new URL("../../personas/attack-tree.md", import.meta.url), "utf8"),
  },
  {
    id: SAST_PERSONA,
    label: "SAST",
    roleMarkdown: readFileSync(new URL("../../personas/sast.md", import.meta.url), "utf8"),
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
