/** The v1 persona. Registered personas gate parsePlan's persona check. */
export const CODE_REVIEW_PERSONA = "code-review";

export const KNOWN_PERSONAS = [CODE_REVIEW_PERSONA] as const;

/**
 * The `code-review` preset plan: five cells, all the code-review persona
 * with different goals and reads edges (spec §plugin-security). Cell 1
 * maps the repo and seeds the checklist; cells 2-4 sweep with recon's map;
 * cell 5 attacks the findings with review rights. The string round-trips
 * through parsePlan (asserted in presets.test.ts).
 */
export function codeReviewPresetPlan(): string {
  return `cells:
  - ordinal: 1
    persona: ${CODE_REVIEW_PERSONA}
    mode: fresh
    goal: Map the codebase, seed the checklist from the file inventory, note trust boundaries
    reads: []
  - ordinal: 2
    persona: ${CODE_REVIEW_PERSONA}
    mode: fresh
    goal: Sweep authorization on every route, mutation, and trust boundary from the recon map
    reads: [1]
  - ordinal: 3
    persona: ${CODE_REVIEW_PERSONA}
    mode: fresh
    goal: Sweep injection paths across SQL, command, template, path, and deserialization sinks
    reads: [1]
  - ordinal: 4
    persona: ${CODE_REVIEW_PERSONA}
    mode: fresh
    goal: Run the pre-baked scanners (gitleaks, semgrep), triage their output, sweep secrets and config
    reads: [1]
  - ordinal: 5
    persona: ${CODE_REVIEW_PERSONA}
    mode: fresh
    goal: Attack every open finding, sec_finding_review each, refute what does not survive
    reads: [1, 2, 3, 4]
    review: true
`;
}
