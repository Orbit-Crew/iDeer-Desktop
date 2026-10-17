from core.policy import LocalPolicy, PolicyDecision, RiskLevel


def test_local_deny_overrides_server_allow() -> None:
    policy = LocalPolicy(denied_capabilities=frozenset({"echo"}))

    assert policy.authorize("echo", {"server_allowed": True}) == PolicyDecision.DENY


def test_file_reads_are_level_zero_even_when_other_capabilities_need_consent() -> None:
    policy = LocalPolicy(consent_required_capabilities=frozenset({"local.files.read"}))

    assert (
        policy.authorize("local.files.read", {"path": "/projects/a.txt"})
        == PolicyDecision.ALLOW
    )


def test_policy_exposes_risk_levels_and_dangerous_actions_cannot_be_silently_allowed() -> (
    None
):
    policy = LocalPolicy(
        always_allow_capabilities=frozenset({"local.files.write"}),
        level_two_capabilities=frozenset({"local.files.write"}),
    )

    assert policy.risk_level("local.files.read", {}) is RiskLevel.LEVEL_0
    assert policy.risk_level("local.files.write", {}) is RiskLevel.LEVEL_2
    assert (
        policy.authorize("local.files.write", {}, consent=True) is PolicyDecision.DENY
    )


def test_custom_level_one_capability_asks_before_execution() -> None:
    policy = LocalPolicy(level_one_capabilities=frozenset({"custom.modify"}))

    assert policy.authorize("custom.modify", {}) is PolicyDecision.CONSENT_REQUIRED
    assert policy.authorize("custom.modify", {}, consent=True) is PolicyDecision.ALLOW


def test_unknown_capability_is_denied_by_default() -> None:
    assert LocalPolicy().authorize("unregistered.capability", {}) is PolicyDecision.DENY
