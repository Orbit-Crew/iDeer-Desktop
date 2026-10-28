"""Local execution policy; this layer can veto every server decision."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .compat import StrEnum


class PolicyDecision(StrEnum):
    ALLOW = "allow"
    DENY = "deny"
    CONSENT_REQUIRED = "consent_required"


class RiskLevel(StrEnum):
    LEVEL_0 = "level_0"
    LEVEL_1 = "level_1"
    LEVEL_2 = "level_2"


@dataclass(frozen=True)
class LocalPolicy:
    denied_capabilities: frozenset[str] = field(default_factory=frozenset)
    consent_required_capabilities: frozenset[str] = field(default_factory=frozenset)
    always_allow_capabilities: frozenset[str] = field(default_factory=frozenset)
    dangerous_capabilities: frozenset[str] = field(default_factory=frozenset)
    level_one_capabilities: frozenset[str] = field(default_factory=frozenset)
    level_two_capabilities: frozenset[str] = field(default_factory=frozenset)

    def risk_level(self, capability: str, payload: dict[str, Any]) -> RiskLevel:
        del payload
        if capability in {"echo", "local.files.list", "local.files.read", "local.files.search"}:
            return RiskLevel.LEVEL_0
        if capability == "local.knowledge.search":
            # Read-only over content the user explicitly imported and froze;
            # the manifest revalidation is what makes any result trustworthy.
            return RiskLevel.LEVEL_0
        if (
            capability in self.level_two_capabilities
            or capability in self.dangerous_capabilities
        ):
            return RiskLevel.LEVEL_2
        if (
            capability in self.level_one_capabilities
            or capability in self.consent_required_capabilities
        ):
            return RiskLevel.LEVEL_1
        if capability in {
            "local.files.write",
            "local.python",
            "local.artifacts.upload",
            "custom.modify",
            # Issue 116: document material leaves the device for a
            # server-orchestrated graph generation, so every request is a
            # local confirmation like the writes above.
            "local.knowledge.material",
            # Issue 122: a Skill script runs machine code on this device, so
            # every request starts as an explicit local confirmation; stored
            # content-bound grants short-circuit the ask, local DENY never
            # does.
            "local.skill.script",
        }:
            return RiskLevel.LEVEL_1
        # Projected MCP tools stay user-visible: consent is required unless the
        # local policy explicitly moves a server or tool to another level.
        if capability.startswith("local.mcp."):
            return RiskLevel.LEVEL_1
        return RiskLevel.LEVEL_2

    def authorize(
        self, capability: str, payload: dict[str, Any], *, consent: bool = False
    ) -> PolicyDecision:
        if capability in self.denied_capabilities:
            return PolicyDecision.DENY
        risk_level = self.risk_level(capability, payload)
        if risk_level is RiskLevel.LEVEL_2:
            return PolicyDecision.DENY
        if capability in self.always_allow_capabilities:
            return PolicyDecision.ALLOW
        if risk_level is RiskLevel.LEVEL_1 and not consent:
            return PolicyDecision.CONSENT_REQUIRED
        return PolicyDecision.ALLOW
