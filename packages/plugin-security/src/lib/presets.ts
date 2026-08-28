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
/**
 * The first turn a fresh engagement runner receives, so the session starts
 * working the moment it is created instead of waiting on the user to type
 * (the hub queues this whether or not the user added focus notes). The
 * runner has the security-engagement-runner skill, so the message only
 * needs to start it: read the plan, fold in any focus notes, then open the
 * `sec_start` approval gate — that gate is the human checkpoint before any
 * spend, so kicking straight to it is safe.
 */
export function securityKickoffPrompt(repoFullName: string, focusNotes?: string): string {
  const notes = focusNotes?.trim();
  const focusLine = notes
    ? `\n\nFocus notes from the user (fold these into the plan before you start):\n${notes}`
    : "";
  return (
    `Begin the security review of ${repoFullName}. ` +
    `Call sec_status to read the engagement plan, summarize the cells for me, ` +
    `adjust the plan with sec_plan_set if the focus notes call for it, ` +
    `then call sec_start to request approval and run the engagement loop.` +
    focusLine
  );
}

export function codeReviewPresetPlan(): string {
  return `cells:
  - ordinal: 1
    persona: ${CODE_REVIEW_PERSONA}
    mode: fresh
    name: recon
    playbook: recon
    goal: Map the codebase, seed the checklist from the file inventory, note trust boundaries
    reads: []
  - ordinal: 2
    persona: ${CODE_REVIEW_PERSONA}
    mode: fresh
    name: authz-sweep
    playbook: authz
    goal: Sweep authorization on every route, mutation, and trust boundary from the recon map
    reads: [1]
  - ordinal: 3
    persona: ${CODE_REVIEW_PERSONA}
    mode: fresh
    name: injection-sweep
    playbook: injection
    goal: Sweep injection paths across SQL, command, template, path, and deserialization sinks
    reads: [1]
  - ordinal: 4
    persona: ${CODE_REVIEW_PERSONA}
    mode: fresh
    name: secrets-config
    playbook: secrets-config
    goal: Run the pre-baked scanners (gitleaks) and any repo-local scanners, triage their output, sweep secrets and config
    reads: [1]
  - ordinal: 5
    persona: ${CODE_REVIEW_PERSONA}
    mode: fresh
    name: verify
    playbook: verify
    goal: Attack every open finding, sec_finding_review each, refute what does not survive
    reads: [1, 2, 3, 4]
    review: true
`;
}
