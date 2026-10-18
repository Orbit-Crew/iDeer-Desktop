from core.consent import ConsentExchange, ConsentStore, request_hash
from core.policy import LocalPolicy, PolicyDecision


def test_reads_are_level_zero_and_writes_require_consent() -> None:
    policy = LocalPolicy()
    assert policy.authorize("local.files.read", {}) is PolicyDecision.ALLOW
    assert policy.authorize("local.files.write", {}) is PolicyDecision.CONSENT_REQUIRED


def test_consent_is_bound_to_payload_hash_and_can_be_always_allowed() -> None:
    store = ConsentStore()
    payload = {"path": "/projects/a.txt", "content": "one"}
    digest = request_hash(payload)
    store.approve("local.files.write", digest)
    assert store.consume("local.files.write", digest) is True
    assert (
        store.consume("local.files.write", request_hash({**payload, "content": "two"}))
        is False
    )
    store.set_always_allow("local.files.write")
    assert store.consume("local.files.write", "different") is True


def test_consent_audit_records_actor_time_and_denial_revokes_pending_approval() -> None:
    store = ConsentStore()
    digest = request_hash({"path": "/projects/a.txt"})
    store.approve(
        "local.files.write", digest, actor_id="alice", decided_at="2026-09-09T10:00:00Z"
    )
    store.deny(
        "local.files.write", digest, actor_id="alice", decided_at="2026-09-09T10:01:00Z"
    )

    assert store.consume("local.files.write", digest) is False
    assert store.audit[-1] == {
        "capability": "local.files.write",
        "request_hash": digest,
        "decision": "denied",
        "actor_id": "alice",
        "decided_at": "2026-09-09T10:01:00Z",
    }


def test_consent_exchange_rejects_execution_when_approved_payload_changes() -> None:
    exchange = ConsentExchange(ConsentStore())
    request = exchange.create_request(
        "local.files.write", {"path": "/projects/a.txt", "content": "one"}
    )

    exchange.decide(
        request, approved=True, actor_id="alice", decided_at="2026-09-09T10:00:00Z"
    )

    assert (
        exchange.authorize(request, {"path": "/projects/a.txt", "content": "two"})
        is False
    )
    assert (
        exchange.authorize(request, {"path": "/projects/a.txt", "content": "one"})
        is True
    )


def test_consent_store_persists_audit_and_one_time_approval(tmp_path) -> None:
    db = tmp_path / "runtime.db"
    payload = {"run_id": "r1", "task": "t1"}
    first = ConsentStore(db_path=db)
    exchange = ConsentExchange(first)
    request = exchange.create_request("local.python", payload)
    exchange.decide(request, approved=True, actor_id="alice")

    restarted = ConsentStore(db_path=db)
    assert restarted.audit[0]["actor_id"] == "alice"
    restarted_exchange = ConsentExchange(restarted)
    assert restarted_exchange.authorize(request, payload)
    assert not restarted_exchange.authorize(request, payload)
    import sqlite3

    with sqlite3.connect(db) as conn:
        assert conn.execute("SELECT count(*) FROM consent_audit").fetchone()[0] == 1
