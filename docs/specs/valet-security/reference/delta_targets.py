"""L3 delta_targets computation per Part 05 sec 5.4. Pure."""

from __future__ import annotations

from typing import Any


def compute_delta_targets(
    persona: str,
    resolved_needs: list[dict[str, Any]],
    loot: dict[str, Any],
) -> dict[str, list[str]]:
    """Return the sorted, deduplicated delta payload for one persona.

    Fields:
      authed_surface: URLs a session or credential unlocks.
      new_hosts:      hosts a scope-expansion added.
      auth_scopes:    roles from resolved credentials.
      test_data:      kinds from resolved test-data needs (per loot rows).
      tool_auth:      tool names from resolved tool-auth needs.

    persona is informative (a call site groups by persona before calling);
    the function does not filter by persona.
    """
    out: dict[str, set[str]] = {
        "authed_surface": set(),
        "new_hosts": set(),
        "auth_scopes": set(),
        "test_data": set(),
        "tool_auth": set(),
    }

    loot_credentials = loot.get("credentials") or []
    loot_test_data = loot.get("test_data") or []

    for need in resolved_needs:
        kind = need.get("kind")
        would_unblock = need.get("would_unblock") or {}
        surface = would_unblock.get("surface_added") or []
        params = ((need.get("proposed_resolution") or {}).get("auto") or {}).get("params") or {}

        if kind in ("session", "credential"):
            for url in surface:
                out["authed_surface"].add(url)
            for cred in loot_credentials:
                role = cred.get("role")
                if role:
                    out["auth_scopes"].add(role)
        elif kind == "scope-expansion":
            host = params.get("host")
            if host:
                out["new_hosts"].add(host)
            for url in surface:
                out["authed_surface"].add(url)
        elif kind == "test-data":
            for td in loot_test_data:
                td_kind = td.get("kind")
                if td_kind:
                    out["test_data"].add(td_kind)
        elif kind == "tool-auth":
            tool = params.get("tool")
            if tool:
                out["tool_auth"].add(tool)

    return {k: sorted(v) for k, v in out.items()}
