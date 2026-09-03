"""L0 needs classification per Part 04 sec 4.3. Pure."""

from __future__ import annotations

from typing import Any


AUTO_CATALOG = {
    "scope-auto-include",
    "propagate-session",
    "rerun-with-existing-loot",
    "create-test-account",
    "tool-auth-reuse",
}

L4_ONLY = {"create-test-account", "tool-auth-reuse"}


def classify_need(need: dict[str, Any], ctx: dict[str, Any]) -> str:
    """Return one of 'auto', 'human', 'deferred', 'invalid'.

    ctx keys:
      authorized_cidrs: list[str]
      loot: dict with sessions/credentials/test_data/tool_auth
      level: int 0..4

    v1 collapses 'deferred' into 'human' (multi-round pivots are v2).
    """
    resolution = need.get("proposed_resolution") or {}
    auto = resolution.get("auto") or {}
    human = resolution.get("human") or {}

    pattern = auto.get("pattern") or ""
    params = auto.get("params") or {}

    level = int(ctx.get("level", 0))

    if pattern in AUTO_CATALOG:
        if level < 3:
            return "human" if human.get("ask") else "invalid"
        if pattern in L4_ONLY and level < 4:
            return "human" if human.get("ask") else "invalid"
        if _can_resolve_params(pattern, params, ctx):
            return "auto"

    if human.get("ask"):
        return "human"

    return "invalid"


def _can_resolve_params(pattern: str, params: dict[str, Any], ctx: dict[str, Any]) -> bool:
    loot = ctx.get("loot") or {}
    if pattern == "scope-auto-include":
        return bool(params.get("host")) and bool(params.get("discovered_ip"))
    if pattern == "propagate-session":
        source = params.get("source_session_id") or ""
        return any(s.get("id") == source for s in loot.get("sessions") or [])
    if pattern == "rerun-with-existing-loot":
        loot_ids = params.get("loot_ids") or []
        seen: set[str] = set()
        for key in ("sessions", "credentials", "test_data", "tool_auth"):
            for row in loot.get(key) or []:
                if row.get("id"):
                    seen.add(row["id"])
        return len(loot_ids) > 0 and all(i in seen for i in loot_ids)
    if pattern == "create-test-account":
        return bool(params.get("signup_url"))
    if pattern == "tool-auth-reuse":
        return bool(params.get("tool"))
    return False
