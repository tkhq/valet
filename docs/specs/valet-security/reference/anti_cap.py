"""L0 outcome functions for the anti-cap checks per Part 07 sec 7.1-7.2.

Pure. Server enforcement wraps these functions inside sec_cell_complete.
"""

from __future__ import annotations

from typing import Any


def check_finding_count_monotonicity(
    prior_state: dict[str, Any],
    new_state: dict[str, Any],
) -> dict[str, str]:
    """Check 1: new state's findings list is at least as long as prior's."""
    prior = prior_state.get("findings") or []
    new = new_state.get("findings") or []
    if len(new) < len(prior):
        return {
            "check": "finding-count monotonicity",
            "result": "fail",
            "reason": f"finding-count decreased (prior: {len(prior)}, new: {len(new)})",
        }
    return {"check": "finding-count monotonicity", "result": "pass"}


def check_pivot_need_citation(
    prior_state: dict[str, Any],
    new_state: dict[str, Any],
    findings_files: dict[str, dict[str, Any]],
) -> dict[str, str]:
    """Check 2: every new finding id has traces_to.pivot_need set.

    findings_files: maps finding_id -> finding-row-like dict with
    traces_to. New finding ids are new_state.findings - prior_state.findings.
    """
    prior = set(prior_state.get("findings") or [])
    new = set(new_state.get("findings") or [])
    for finding_id in sorted(new - prior):
        row = findings_files.get(finding_id) or {}
        traces = row.get("traces_to") or {}
        if not traces.get("pivot_need"):
            return {
                "check": "pivot_need citation",
                "result": "fail",
                "reason": f"schema violation: finding {finding_id} missing traces_to.pivot_need",
            }
    return {"check": "pivot_need citation", "result": "pass"}
