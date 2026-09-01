"""L3 auto-catalog outcome computation per Part 05 sec 5.5-5.10.

Every function is PURE: it returns a plan (outcome, side-effect description)
rather than performing I/O. The Valet runtime carries the plan into
sec_fs_write / sec_loot_write / manifest.delta.yml write.
"""

from __future__ import annotations

import ipaddress
from typing import Any


def scope_auto_include(
    need_id: str,
    params: dict[str, Any],
    ctx: dict[str, Any],
) -> dict[str, Any]:
    """Auto-approve a scope-expansion need if the discovered IP is in an
    authorized CIDR.

    Returns:
      outcome=ok: manifest_delta names the host to add and matched_cidr.
      outcome=failed: reason names the specific failure.

    The log_entry field carries the auto-setups.log JSON line the caller
    appends. This is normative (Appendix D, vector auto-catalog-001).
    """
    host = params.get("host")
    ip_str = params.get("discovered_ip")
    if not host or not ip_str:
        return {
            "outcome": "failed",
            "reason": "malformed params",
            "log_entry": {
                "need_id": need_id,
                "pattern": "scope-auto-include",
                "outcome": "failed",
                "reason": "malformed params",
            },
        }
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return {
            "outcome": "failed",
            "reason": "malformed IP",
            "log_entry": {
                "need_id": need_id,
                "pattern": "scope-auto-include",
                "outcome": "failed",
                "reason": "malformed IP",
            },
        }
    for cidr in ctx.get("authorized_cidrs") or []:
        try:
            network = ipaddress.ip_network(cidr, strict=False)
        except ValueError:
            continue
        if ip in network:
            return {
                "outcome": "ok",
                "manifest_delta": {"authorized_hosts": [host]},
                "log_entry": {
                    "need_id": need_id,
                    "pattern": "scope-auto-include",
                    "outcome": "ok",
                    "matched_cidr": cidr,
                },
            }
    return {
        "outcome": "failed",
        "reason": "IP not in authorized CIDRs",
        "log_entry": {
            "need_id": need_id,
            "pattern": "scope-auto-include",
            "outcome": "failed",
            "reason": "IP not in authorized CIDRs",
        },
    }


def propagate_session(
    need_id: str,
    params: dict[str, Any],
    ctx: dict[str, Any],
) -> dict[str, Any]:
    """Plan a copy of a source session's cookie jar to a target persona.

    Returns:
      outcome=ok: file_copied names source and target paths (relative to
                  engagement root).
      outcome=failed: reason.
    """
    source_id = params.get("source_session_id")
    target_persona = params.get("target_persona")
    if not source_id:
        return _failed(need_id, "propagate-session", "source session id missing")
    loot = ctx.get("loot") or {}
    sessions = loot.get("sessions") or []
    session = next((s for s in sessions if s.get("id") == source_id), None)
    if session is None:
        return {
            "outcome": "failed",
            "reason": "session not found",
            "log_entry": {
                "need_id": need_id,
                "pattern": "propagate-session",
                "outcome": "failed",
                "reason": "session not found",
            },
        }
    source_path = session.get("cookie_jar") or f"loot/cookies-{source_id}.txt"
    target_path = f"{target_persona}/loot/cookies-{source_id}.txt" if target_persona else source_path
    return {
        "outcome": "ok",
        "file_copied": {"source": source_path, "target": target_path},
        "log_entry": {
            "need_id": need_id,
            "pattern": "propagate-session",
            "outcome": "ok",
        },
    }


def rerun_with_existing_loot(
    need_id: str,
    params: dict[str, Any],
    ctx: dict[str, Any],
) -> dict[str, Any]:
    """Plan a post-pivot-delta re-dispatch derived from existing loot.

    Derivation rule (Part 05 sec 5.7): for a session in loot_ids with
    host H, append 'https://<H>/*' to authed_surface. For a credential
    with role R, append R to auth_scopes.
    """
    persona = params.get("persona")
    loot_ids = params.get("loot_ids") or []
    if not persona or not loot_ids:
        return _failed(need_id, "rerun-with-existing-loot", "persona or loot_ids missing")

    loot = ctx.get("loot") or {}
    sessions = {s["id"]: s for s in (loot.get("sessions") or []) if s.get("id")}
    credentials = {c["id"]: c for c in (loot.get("credentials") or []) if c.get("id")}
    test_data = {t["id"]: t for t in (loot.get("test_data") or []) if t.get("id")}
    tool_auth = {a["id"]: a for a in (loot.get("tool_auth") or []) if a.get("id")}
    all_ids = set(sessions) | set(credentials) | set(test_data) | set(tool_auth)

    if any(i not in all_ids for i in loot_ids):
        return {
            "outcome": "failed",
            "reason": "loot not found",
            "log_entry": {
                "need_id": need_id,
                "pattern": "rerun-with-existing-loot",
                "outcome": "failed",
                "reason": "loot not found",
            },
        }

    delta = {
        "authed_surface": set(),
        "new_hosts": set(),
        "auth_scopes": set(),
        "test_data": set(),
        "tool_auth": set(),
    }
    for lid in loot_ids:
        if lid in sessions:
            host = sessions[lid].get("host")
            if host:
                delta["authed_surface"].add(f"https://{host}/*")
        if lid in credentials:
            role = credentials[lid].get("role")
            if role:
                delta["auth_scopes"].add(role)
        if lid in test_data:
            kind = test_data[lid].get("kind")
            if kind:
                delta["test_data"].add(kind)
        if lid in tool_auth:
            tool = tool_auth[lid].get("tool")
            if tool:
                delta["tool_auth"].add(tool)

    return {
        "outcome": "ok",
        "rerun_plan_entry": {
            "persona": persona,
            "mode": "post-pivot-delta",
            "delta_targets": {k: sorted(v) for k, v in delta.items()},
        },
        "log_entry": {
            "need_id": need_id,
            "pattern": "rerun-with-existing-loot",
            "outcome": "ok",
        },
    }


def create_test_account(
    need_id: str,
    params: dict[str, Any],
    ctx: dict[str, Any],
) -> dict[str, Any]:
    """L4 signup PLAN. Real execution requires network; this function
    stops at the plan step and returns what would be POSTed.

    In v1 conformance tests, this returns a static failure to keep the
    kernel side-effect-free. A real implementation performs the POST.
    """
    signup_url = params.get("signup_url")
    if not signup_url:
        return _failed(need_id, "create-test-account", "signup_url missing")
    return {
        "outcome": "planned",
        "reason": "L4 side effect stub; real implementation POSTs",
        "log_entry": {
            "need_id": need_id,
            "pattern": "create-test-account",
            "outcome": "planned",
        },
    }


def tool_auth_reuse(
    need_id: str,
    params: dict[str, Any],
    ctx: dict[str, Any],
) -> dict[str, Any]:
    """L4 tool-auth-reuse. v1 has no shared loot store; always fails."""
    return {
        "outcome": "failed",
        "reason": "no cached auth for tool",
        "log_entry": {
            "need_id": need_id,
            "pattern": "tool-auth-reuse",
            "outcome": "failed",
            "reason": "no cached auth for tool",
        },
    }


_DISPATCH = {
    "scope-auto-include": scope_auto_include,
    "propagate-session": propagate_session,
    "rerun-with-existing-loot": rerun_with_existing_loot,
    "create-test-account": create_test_account,
    "tool-auth-reuse": tool_auth_reuse,
}


def execute_pattern(
    pattern: str,
    need_id: str,
    params: dict[str, Any],
    ctx: dict[str, Any],
) -> dict[str, Any]:
    """Dispatch to the pattern implementation."""
    fn = _DISPATCH.get(pattern)
    if fn is None:
        return _failed(need_id, pattern, "unknown pattern")
    return fn(need_id, params, ctx)


def _failed(need_id: str, pattern: str, reason: str) -> dict[str, Any]:
    return {
        "outcome": "failed",
        "reason": reason,
        "log_entry": {
            "need_id": need_id,
            "pattern": pattern,
            "outcome": "failed",
            "reason": reason,
        },
    }
