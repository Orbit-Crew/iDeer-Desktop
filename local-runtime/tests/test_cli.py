"""start-runtime credential resolution must keep secrets out of argv (05-M8)."""

from __future__ import annotations

import io
import sys

import pytest

from core.cli import _resolve_runtime_credentials, build_parser, main


def test_session_credentials_are_not_required_argv(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("IDEER_LOCAL_SESSION_TOKEN", raising=False)
    monkeypatch.delenv("IDEER_LOCAL_PRIVATE_KEY", raising=False)
    args = build_parser().parse_args(
        ["start-runtime", "--server-url", "ws://127.0.0.1:9/ws", "--device-id", "d"]
    )
    assert args.session_token == ""
    assert args.private_key == ""


def test_session_credentials_default_from_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("IDEER_LOCAL_SESSION_TOKEN", "tok")
    monkeypatch.setenv("IDEER_LOCAL_PRIVATE_KEY", "b64key")
    args = build_parser().parse_args(
        ["start-runtime", "--server-url", "ws://127.0.0.1:9/ws", "--device-id", "d"]
    )
    assert args.session_token == "tok"
    assert args.private_key == "b64key"


def test_dash_reads_credentials_from_stdin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sys, "stdin", io.StringIO("token-value\nkey-value"))
    assert _resolve_runtime_credentials("-", "-") == ("token-value", "key-value")


def test_missing_credentials_fail_closed() -> None:
    with pytest.raises(ValueError, match="stdin"):
        _resolve_runtime_credentials("", "")


def test_start_runtime_without_credentials_reports_and_exits(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("IDEER_LOCAL_SESSION_TOKEN", raising=False)
    monkeypatch.delenv("IDEER_LOCAL_PRIVATE_KEY", raising=False)
    exit_code = main(
        [
            "start-runtime",
            "--server-url",
            "ws://127.0.0.1:9/ws",
            "--device-id",
            "device-1",
            "--session-token",
            "",
            "--private-key",
            "",
        ]
    )
    assert exit_code == 1
    assert "stdin" in capsys.readouterr().err
