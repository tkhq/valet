# Part 07: Anti-Fabrication and Anti-Cap Checks

*Depends on: Part 00, Part 01, Part 02, Part 05. Conformance: L4.*

## Purpose

This part defines the three anti-cap checks the orchestrator applies inside `sec_cell_complete`. Every check enforces one invariant from Part 00. Every check ships as a pure outcome function at L0 (vectors in §D.5) and as a server-side gate at L4.

## Check 1: Finding-count monotonicity

**Enforces:** INV-2 (Part 00).

**Trigger:** every `sec_cell_complete` call on a cell with `mode: post-pivot-delta`.

**Server-side mechanics.**

1. Read the delta cell's `reads: [<original ordinal>]` (there SHALL be exactly one entry, naming the original run).
2. `sec_fs_read` the original cell's latest state doc revision at `/cells/<original NN>-<slug>/state.yml`. Extract `findings[]`, count entries. `prior_count`.
3. `sec_fs_read` the new state doc's latest revision. Extract `findings[]`, count entries. `new_count`.
4. If `new_count < prior_count`, mark the cell NOT_ASSESSED with `reason: "finding-count decreased (prior: N, new: M)"`. `sec_cell_complete` returns 400 with the reason; the cell stays `running`.
5. If `new_count >= prior_count`, the check passes.

**Why.** A `post-pivot-delta` cell extends the original findings list. It never rewrites. A count decrease is either a bug (persona lost findings) or a schema violation (persona rewrote history).

**False-positive handling.** If a persona determines a prior finding was a false positive, it MUST still include the prior finding id in the new state doc's `findings[]`, then call `sec_finding_review status=refuted reason=<why>` on that id. The list preserves; the row's status flips. Removing the id is a schema violation.

**Deduplication edge case.** If a persona merges two findings that share a fingerprint, the count MAY decrease. In that case the persona SHOULD leave every original id in the list and mark the duplicate's status via `sec_finding_review status=refuted reason="duplicate of <id>"`. The verifier persona (§7.4) audits the fingerprints.

## Check 2: `pivot_need` citation

**Enforces:** INV-3 (Part 00).

**Trigger:** every `sec_cell_complete` call on a cell with `mode: post-pivot-delta`.

**Server-side mechanics.**

1. Compute `new_finding_ids = new_state.findings[] - prior_state.findings[]` (set difference).
2. For each id in `new_finding_ids`, read the `security_findings` row.
3. If any row has `traces_to.pivot_need` empty or NULL, mark the cell NOT_ASSESSED with `reason: "schema violation: finding <id> missing traces_to.pivot_need"`. Return 400. Cell stays `running`.
4. Optional: verify `traces_to.pivot_need` names a need id resolved in the pivot round preceding this delta cell. If not, `reason: "traces_to.pivot_need <need id> not in the resolved set for this delta"`. Recommended but NOT required at L4.
5. If every new finding has a valid citation, the check passes.

**How `traces_to.pivot_need` gets stamped.** Two paths:

1. The `sec_finding_report` engine tool reads the calling child session's cell row, sees `mode: post-pivot-delta`, and stamps `traces_to.pivot_need` from the dispatch's DELTA TARGETS provenance (specifically, `from_needs[0]` from the matching `pivot.yml.rerun_plan[]` entry). The persona does NOT need to supply the field.
2. The persona MAY override by passing `traces_to: {pivot_need: <specific need id>}` in the `sec_finding_report` call. This is useful when a delta re-run resolves multiple needs and the persona wants each new finding to cite the specific need that unblocked it.

**Anti-cap rationale.** Provenance. Every new finding in a delta re-run exists because a pivot need was resolved. The report must trace which one. Without this citation, the report cannot answer "why did we find this now and not earlier?"

## Check 3: Tool-version audit

**Enforces:** INV-6 (Part 00).

**Trigger:** the `verifier` persona runs at engagement close (base design M-P3). This check is NOT a `sec_cell_complete` gate at L4; it emits informational findings for humans to triage.

**Server-side mechanics.**

1. The verifier persona reads `/cells/<NN>-<slug>/tools.yml` for every cell that shipped one.
2. For every tool `t` in a cell's `tools.yml`:
    - Look up the pinned version in Part 03's inventory for that persona.
    - Compare `t.version` to the pin. String equality (personas SHOULD strip surrounding decoration; the inventory pin is the canonical form).
    - On mismatch, emit `sec_finding_report severity=medium title="Tool version mismatch: <t.name> in <persona>" body="<detail>"`.
3. On any tool that is `present: false` where the inventory lists it: emit `sec_coverage_report status=not_assessed area=<pack> tool=<t.name> reason=<consequence>` (or verify the persona already emitted one).

**Why informational, not a gate?** Version drift changes findings, but the correct response is human judgment (re-run the engagement with the pinned version), not automatic settlement refusal. See Appendix B §T-3.

**Example finding.**
```json
{
  "id": "F-verifier-tool-version-sast-gitleaks",
  "title": "Tool version mismatch: gitleaks in sast cell",
  "severity": "medium",
  "file": null,
  "line": null,
  "body": "The sast persona ran gitleaks version 8.17.0. Inventory pins 8.18.2. Version drift changes rule sets; the sast findings MAY be incomplete. Re-run the engagement with the pinned version.",
  "traces_to": {}
}
```

## The verifier persona and other L4 audits

Base design M-P3: verifier runs as a distinct persona at engagement close. In v1, its L4 audits are:

1. **Finding-count monotonicity audit.** For every `mode: post-pivot-delta` cell, re-do Check 1. Emit an informational finding on any prior gate slip.
2. **`pivot_need` citation audit.** For every `mode: post-pivot-delta` cell, re-do Check 2.
3. **Tool-version audit.** §7.3 above.
4. **Needs coverage audit** (v2, Appendix C §C.2). Verify every `/needs/*.yml` need was resolved or deferred, not silently dropped.

The verifier's meta-findings are `security_findings` rows with `title` prefixed `[verifier]` and `traces_to.pivot_need` empty.

## Anti-cap rationale

The term "anti-cap" comes from "capping metrics" (gaming a KPI). In security work, capping might look like:
- Hiding findings to make a report cleaner.
- Removing findings from a delta re-run to show "progress" (fewer findings over time).
- Omitting provenance to obscure why findings emerged.

The three checks counter these:
1. Finding-count monotonicity prevents hiding.
2. `pivot_need` citation prevents provenance loss.
3. Tool-version audit prevents "the tool changed" alibis without evidence.

The checks are not paranoia. They are schema invariants (INV-2, INV-3, INV-6). A violation is a bug, not malice, but the enforcement is the same.

## Purely functional versions (L0 vectors)

The three checks all ship as pure outcome functions at L0. See §D.5 for the vectors.

```python
def check_finding_count_monotonicity(prior_state, new_state):
    prior = prior_state.get("findings", []) or []
    new = new_state.get("findings", []) or []
    if len(new) < len(prior):
        return {
            "check": "finding-count monotonicity",
            "result": "fail",
            "reason": f"finding-count decreased (prior: {len(prior)}, new: {len(new)})",
        }
    return {"check": "finding-count monotonicity", "result": "pass"}


def check_pivot_need_citation(prior_state, new_state, findings_files):
    prior = set(prior_state.get("findings", []) or [])
    new = set(new_state.get("findings", []) or [])
    for fid in sorted(new - prior):
        f = findings_files.get(fid, {})
        traces = (f.get("traces_to") or {})
        if not traces.get("pivot_need"):
            return {
                "check": "pivot_need citation",
                "result": "fail",
                "reason": f"schema violation: finding {fid} missing traces_to.pivot_need",
            }
    return {"check": "pivot_need citation", "result": "pass"}
```

## Conformance

**L0.** The three checks ship as pure functions. Vectors in §D.5.

**L1, L2, L3.** No `sec_cell_complete` gate for anti-cap checks. Personas MAY still cite `traces_to.pivot_need` on their own; the runner MAY still surface a monotonicity warning; but the settlement condition remains only the base check (`status: done`, both pending counts 0).

**L4.** `sec_cell_complete` MUST enforce Check 1 and Check 2 for every `mode: post-pivot-delta` cell. The verifier persona MUST emit Check 3 at engagement close. A failed Check 1 or Check 2 gate holds the cell at `running` with a corrective error; the persona MUST re-emit and retry.
