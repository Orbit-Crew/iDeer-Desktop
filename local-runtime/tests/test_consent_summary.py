"""Tests for consent summary formatting."""

from core.consent import PendingConsent, render_consent_summary
from core.policy import RiskLevel


def test_request_summary_includes_request_hash():
    """Spec requirement: consent popup shows request_hash for verification."""
    summary = render_consent_summary(
        "local.files.write",
        {"path": "/projects/a.txt", "content": "hello", "run_id": "r1"},
        request_hash="abc123" * 10,  # 64 chars
    )
    assert "request_hash" in summary
    assert summary["request_hash"] == "abc123" * 10


def test_request_summary_without_hash_is_empty():
    """Backward compatibility: omit hash when not provided."""
    summary = render_consent_summary("local.files.write", {"path": "/x"})
    assert "request_hash" not in summary


def test_pending_consent_carries_request_hash():
    """PendingConsent must expose the hash the user sees."""
    pc = PendingConsent(
        task_id="t1",
        capability="local.files.write",
        payload={"path": "/a"},
        request_hash="hash123",
        risk_level=RiskLevel.LEVEL_1.value,
        silenceable=True,
        summary={"capability": "local.files.write", "request_hash": "hash123"},
        requested_at=0.0,
    )
    assert pc.request_hash == "hash123"
    assert "request_hash" in pc.as_dict()["summary"]


def test_request_summary_is_presentation_formatter():
    """request_summary belongs to the presentation layer, not hashing logic.

    It should be callable as a pure formatter and not leak into ConsentStore.
    """
    # Just a display helper — no state, no side effects.
    out = render_consent_summary("local.python", {"script": "print(1)"})
    assert out["command"] == "print(1)"
    assert "capability" in out
