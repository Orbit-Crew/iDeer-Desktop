from core.capabilities import CapabilityAnnouncement, CapabilityRegistry


def test_offline_or_incompatible_device_has_no_effective_capabilities() -> None:
    registry = CapabilityRegistry()
    registry.update(CapabilityAnnouncement("d1", frozenset({"local.files.read"}), online=False))
    assert (
        registry.effective(
            device_id="d1",
            agent={"local.files.read"},
            caller={"local.files.read"},
            workflow={"local.files.read"},
            platform={"local.files.read"},
        )
        == frozenset()
    )


def test_announced_capabilities_are_policy_compatible_by_default() -> None:
    registry = CapabilityRegistry()
    registry.update(CapabilityAnnouncement("d1", frozenset({"local.files.read"}), online=True))

    assert registry.effective(
        device_id="d1",
        agent={"local.files.read"},
        caller={"local.files.read"},
        workflow={"local.files.read"},
        platform={"local.files.read"},
    ) == {"local.files.read"}
