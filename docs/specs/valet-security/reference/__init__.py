"""Reference implementation for the Valet Security v1 spec, L0 kernel.

This package ships every pure decision function the spec pins:
- fingerprint.fingerprint (Part 02).
- needs.classify_need (Part 04).
- delta_targets.compute_delta_targets (Part 05 sec 5.4).
- auto_catalog.execute_pattern (Part 05 sec 5.5 to 5.10).
- anti_cap.check_finding_count_monotonicity (Part 07 sec 7.1).
- anti_cap.check_pivot_need_citation (Part 07 sec 7.2).

Every function is pure. No I/O, no clock, no randomness. The conformance
runner (scripts/run-vectors.py) dispatches by vector filename.
"""

__version__ = "1.0.0"
