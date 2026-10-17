from pathlib import Path

from core.consent import ConsentStore, request_hash
from core.file_service import LocalFileService
from core.files import LocalFileStore, RootConfig
from core.policy import PolicyDecision


def test_write_requires_approval_and_then_executes(tmp_path: Path) -> None:
    service = LocalFileService(LocalFileStore([RootConfig("/projects", tmp_path)]))
    payload = {"path": "/projects/a.txt", "content": "approved"}
    assert (
        service.execute("local.files.write", payload).decision
        is PolicyDecision.CONSENT_REQUIRED
    )
    assert service.execute("local.files.write", payload, consent=True).value == {
        "written": True
    }
    assert (tmp_path / "a.txt").read_text() == "approved"


def test_approved_write_is_bound_to_the_exact_payload(tmp_path: Path) -> None:
    store = ConsentStore()
    service = LocalFileService(
        LocalFileStore([RootConfig("/projects", tmp_path)]), consent=store
    )
    payload = {"path": "/projects/a.txt", "content": "approved"}
    store.approve("local.files.write", request_hash(payload))

    changed = {**payload, "content": "tampered"}
    assert (
        service.execute("local.files.write", changed).decision
        is PolicyDecision.CONSENT_REQUIRED
    )
    assert not (tmp_path / "a.txt").exists()

    assert service.execute("local.files.write", payload).value == {"written": True}
    assert (tmp_path / "a.txt").read_text() == "approved"
