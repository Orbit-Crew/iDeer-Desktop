"""Session permission tiers (#74): the chat session's device-side policy.

A tier is a per-session standing answer to the device's own consent asks.
``ask_first`` (the default for every newly loaded session, never remembered
across sessions) keeps today's per-action consent. ``autonomous`` runs
authorized-folder writes without asking. ``full`` also opens the command line
(the controlled terminal rides issue #111). The tier is folder-anchored:
outside the confirmed workspace and protected paths are refused in every
tier, and the tier is only ever consulted after the local policy has already
vetoed - a local DENY or a LEVEL_2 capability wins over any tier, so the
tier can never exceed the platform permission intersection.

Tier choices and every switch land in the device audit log, and executions
resolved by a tier carry ``tier:<tier>`` as their receipt's consent basis.
"""

from __future__ import annotations

from typing import Any, Callable

from .audit import AuditKind
from .compat import StrEnum


class SessionTier(StrEnum):
    """The three session tiers; a new session always starts at the lowest."""

    ASK_FIRST = "ask_first"
    AUTONOMOUS = "autonomous"
    FULL = "full"


class GateDecision(StrEnum):
    """What the tier gate resolves for one consent-worthy request."""

    ALLOW = "allow"
    ASK = "ask"
    DENY = "deny"


DEFAULT_SESSION_TIER = SessionTier.ASK_FIRST

# Folder-anchored capabilities a tier may auto-execute. The command line
# (local.python) is a full-tier capability; autonomous covers the folder
# writes. Everything else - skill scripts, material reads, MCP tools - stays
# on the explicit consent path in every tier, which is the deliberate reading
# of "夹内全放开": those capabilities are content- or platform-bound, not
# folder-anchored, so the session tier's folder scope cannot reach them and
# the platform capability intersection (#70: 档位不越平台权限) keeps their
# own authorization chains ahead.
TIER_AUTONOMOUS_CAPABILITIES = frozenset({"local.files.write"})
TIER_FULL_CAPABILITIES = frozenset({"local.files.write", "local.python"})


def payload_anchor(payload: dict[str, Any], capability: str) -> str:
    """The one folder-anchored target a tier-gated capability declares.

    Both wire shapes are accepted: the flat tray-era payload and the
    ``arguments`` envelope the workspace service reads.
    """
    if capability == "local.files.write":
        args = payload.get("arguments", payload.get("args", payload))
        path = args.get("path") if isinstance(args, dict) else None
        return path if isinstance(path, str) and path else ""
    if capability == "local.python":
        root = payload.get("working_root")
        return root if isinstance(root, str) and root else ""
    return ""


def tier_gate_decision(
    tier: SessionTier,
    capability: str,
    payload: dict[str, Any],
    classify: Callable[[str], str],
) -> GateDecision:
    """Resolve one consent-worthy request against the session tier.

    Returns :attr:`GateDecision.ALLOW` (run it, the tier is the standing
    answer), :attr:`GateDecision.ASK` (fall through to the ordinary consent
    flow) or :attr:`GateDecision.DENY` (refuse without asking). ``classify``
    maps a declared target to ``"inside"`` (the confirmed workspace),
    ``"protected"`` or ``"outside"``; anything it cannot prove inside is
    refused in the upgraded tiers, never widened.
    """
    if tier is SessionTier.ASK_FIRST:
        return GateDecision.ASK
    if capability not in TIER_FULL_CAPABILITIES:
        return GateDecision.ASK
    if capability == "local.python" and tier is not SessionTier.FULL:
        return GateDecision.ASK
    anchor = payload_anchor(payload, capability)
    if not anchor:
        # Without its folder anchor the request cannot be proven in-folder.
        return GateDecision.DENY
    try:
        scope = classify(anchor)
    except Exception:  # noqa: BLE001 - a classifier failure refuses, never widens
        return GateDecision.DENY
    return GateDecision.ALLOW if scope == "inside" else GateDecision.DENY


class SessionTierRegistry:
    """In-memory thread_id -> tier state; process lifetime only.

    Nothing here is persisted: a restarted runtime, a reloaded thread or a
    fresh session starts at the lowest tier again, so a tier choice can
    never silently outlive the chat session that made it.
    """

    def __init__(self, audit: Any = None) -> None:
        self._tiers: dict[str, SessionTier] = {}
        self._audit = audit

    def tier_for(self, thread_id: str) -> SessionTier:
        return self._tiers.get(thread_id, DEFAULT_SESSION_TIER)

    def set(self, thread_id: str, tier: SessionTier, *, actor_id: str = "session-tier") -> None:
        previous = self.tier_for(thread_id)
        self._tiers[thread_id] = tier
        if self._audit is not None:
            self._audit.record(
                AuditKind.CONFIG,
                "session_tier_changed",
                capability="session.tier",
                detail={"thread_id": thread_id, "from": previous.value, "to": tier.value},
                actor_id=actor_id,
            )

    def reset(self) -> None:
        """Forget every tier choice (a thread load or identity change).

        Each dropped choice is audited: the execution record must show the
        fall-back to the lowest tier, not only the upgrades into it (#74).
        """
        for thread_id, tier in self._tiers.items():
            if tier is DEFAULT_SESSION_TIER or self._audit is None:
                continue
            self._audit.record(
                AuditKind.CONFIG,
                "session_tier_expired",
                capability="session.tier",
                detail={"thread_id": thread_id,
                        "from": tier.value, "to": DEFAULT_SESSION_TIER.value},
                actor_id="session-tier",
            )
        self._tiers.clear()
