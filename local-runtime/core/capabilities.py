"""Device capability announcements and the six-factor effective set."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CapabilityAnnouncement:
    device_id: str
    capabilities: frozenset[str]
    online: bool = True
    policy_compatible: frozenset[str] | None = None


class CapabilityRegistry:
    def __init__(self) -> None:
        self._devices: dict[str, CapabilityAnnouncement] = {}

    def update(self, announcement: CapabilityAnnouncement) -> None:
        self._devices[announcement.device_id] = announcement

    def get(self, device_id: str) -> CapabilityAnnouncement | None:
        return self._devices.get(device_id)

    def effective(
        self,
        *,
        device_id: str,
        agent: set[str],
        caller: set[str],
        workflow: set[str],
        platform: set[str],
    ) -> frozenset[str]:
        device = self._devices.get(device_id)
        if device is None or not device.online:
            return frozenset()
        compatible = device.capabilities if device.policy_compatible is None else device.policy_compatible
        return frozenset(agent & caller & set(device.capabilities) & set(compatible) & workflow & platform)
