"""Issue 101 public receipt storage contract. Fixtures contain no real identity."""
from pathlib import Path
import json
import subprocess
import sys

import pytest

from core.receipt_ledger import ReceiptLedger, ReceiptStorageError


BINDING = {"server_origin": "https://fixture.invalid", "user_id": "account-A",
           "device_id": "device-A", "device_public_key": "fixture-device-key", "broker_public_key": "fixture-broker-key"}
TASK = {"task_id": "task-101", "run_id": "run-101", "tool_call_id": "tool-101",
        "capability": "local.files.read", "request_hash": "a" * 64,
        "task_signature": "signed-fixture", "original_session_id": "session-A"}
RECEIPT = {"task_id": "task-101", "run_id": "run-101", "capability": "local.files.read",
           "request_hash": "a" * 64, "payload_hash": "a" * 64, "status": "completed",
           "policy_decision": "allow", "policy_version": "1", "result_hash": "b" * 64}


def test_restart_pending_identity_protection_and_confirmed_cleanup(tmp_path: Path):
    path = tmp_path / "receipts.db"
    ledger = ReceiptLedger(path)
    assert ledger.admit(BINDING, TASK)
    saved = ledger.complete(BINDING, RECEIPT)
    reopened = ReceiptLedger(path)
    assert reopened.pending(BINDING) == [saved]
    assert reopened.pending({**BINDING, "user_id": "account-B"}) == []
    assert reopened.clear_confirmed(BINDING) == 0
    assert reopened.history(BINDING)[0]["delivery_state"] == "pending"
    assert reopened.confirm(saved["receipt_id"], saved["receipt_hash"], "ack-101")
    assert reopened.clear_confirmed(BINDING) == 1
    assert ReceiptLedger(path).history(BINDING)[0]["delivery_state"] == "cleaned"
    assert not ReceiptLedger(path).admit(BINDING, TASK)


def test_storage_is_unbounded_private_and_survives_a_process_restart(tmp_path):
    path = tmp_path / "receipts.db"
    ledger = ReceiptLedger(path)
    for i in range(27):
        task = {**TASK, "task_id": f"task-{i}"}
        assert ledger.admit(BINDING, task)
        ledger.complete(BINDING, {**RECEIPT, "task_id": task["task_id"],
            "content": "SECRET_FULL_BODY", "session_token": "SECRET_CREDENTIAL"})
    script = "import json,sys; from core.receipt_ledger import ReceiptLedger; print(json.dumps(ReceiptLedger(sys.argv[1]).pending(json.loads(sys.argv[2]))))"
    result = subprocess.run([sys.executable, "-c", script, str(path), json.dumps(BINDING)],
                            capture_output=True, text=True, check=True)
    assert len(json.loads(result.stdout)) == 27
    assert len(ledger.history(BINDING)) == 20
    assert b"SECRET_FULL_BODY" not in path.read_bytes()
    assert b"SECRET_CREDENTIAL" not in path.read_bytes()


def test_failed_admission_blocks_and_failed_completion_keeps_uncertain_claim(tmp_path):
    broken = ReceiptLedger(tmp_path / "missing" / "receipts.db")
    with pytest.raises(ReceiptStorageError, match="RECEIPT_STORAGE_UNAVAILABLE"):
        broken.admit(BINDING, TASK)
    assert broken.error == "RECEIPT_STORAGE_UNAVAILABLE"
    path = tmp_path / "valid.db"
    ledger = ReceiptLedger(path)
    assert ledger.admit(BINDING, TASK)
    # A real SQLite write rejection on an isolated test database, no full disk.
    ledger.path = path.as_uri() + "?mode=ro"
    with pytest.raises(ReceiptStorageError):
        ledger.complete(BINDING, RECEIPT)
    assert ledger.snapshot(BINDING)["storageError"] == "RECEIPT_STORAGE_UNAVAILABLE"
    recovered = ReceiptLedger(path)
    assert recovered.history(BINDING)[0]["delivery_state"] == "uncertain"
    assert not recovered.admit(BINDING, TASK)


def test_history_summary_counts_records_beyond_visible_page(tmp_path):
    ledger = ReceiptLedger(tmp_path / "receipts.db")
    for i in range(23):
        ledger.admit(BINDING, {**TASK, "task_id": f"history-{i}"})
    view = ledger.snapshot(BINDING)
    assert view["total"] == 23
    assert view["uncertain"] == 23
    assert view["pending"] == view["confirmed"] == 0
    assert len(view["rows"]) == 20


def test_cleanup_tombstone_cannot_be_resurrected_by_a_replayed_task_error(tmp_path):
    ledger = ReceiptLedger(tmp_path / "receipts.db")
    ledger.admit(BINDING, TASK)
    saved = ledger.complete(BINDING, RECEIPT)
    ledger.confirm(saved['receipt_id'], saved['receipt_hash'], 'ack-101')
    ledger.clear_confirmed(BINDING)
    assert ledger.complete(BINDING, {**RECEIPT, 'status': 'denied', 'error_code': 'TASK_REPLAYED'}) is None
    assert ledger.history(BINDING)[0]['delivery_state'] == 'cleaned'
    assert ledger.pending(BINDING) == []


def test_current_identity_sees_and_clears_only_its_own_history(tmp_path):
    ledger = ReceiptLedger(tmp_path / "receipts.db")
    ledger.admit(BINDING, TASK)
    saved = ledger.complete(BINDING, RECEIPT)
    ledger.confirm(saved['receipt_id'], saved['receipt_hash'], 'ack-101')
    other = {**BINDING, 'user_id': 'account-B'}
    assert ledger.snapshot(other)['total'] == 0
    assert ledger.clear_confirmed(other) == 0
    assert ledger.history(other) == []
    assert ledger.snapshot(BINDING)['confirmed'] == 1
    assert ledger.snapshot(None)['total'] == 0


def test_safe_target_and_stable_error_category_survive_restart(tmp_path):
    from core.receipts import LocalExecutionReceipt, safe_logical_target
    assert safe_logical_target({'path': '/workspace/00000000-0000-0000-0000-000000000101/missing.txt'}) == '/workspace/00000000-0000-0000-0000-000000000101/missing.txt'
    target = '/workspace/00000000-0000-0000-0000-000000000101/missing.txt'
    assert safe_logical_target({'path': 'ignored', 'arguments': {'path': target}}) == target
    assert safe_logical_target({'path': 'ignored', 'args': {'path': target}}) == target
    assert safe_logical_target({'path': 'C:\\private\\SECRET.txt'}).startswith('sha256:')
    ledger = ReceiptLedger(tmp_path / 'receipts.db')
    task = {**TASK, 'logical_target': '/workspace/00000000-0000-0000-0000-000000000101/missing.txt'}
    ledger.admit(BINDING, task)
    receipt = LocalExecutionReceipt('run-101', 'task-101', 'local.files.read', 'allow', 'failed', 'a' * 64,
                                    error_code='NOT_FOUND')
    ledger.complete(BINDING, receipt.as_dict())
    row = ReceiptLedger(tmp_path / 'receipts.db').history(BINDING)[0]
    assert row['logical_target'] == '/workspace/00000000-0000-0000-0000-000000000101/missing.txt'
    assert row['error_code'] == 'NOT_FOUND'
