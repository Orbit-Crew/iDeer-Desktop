"""The public audit API must release its own SQLite file after each call."""
from core.audit import AuditKind, LocalAuditLog


def test_audit_operations_release_the_database_before_profile_cleanup(tmp_path):
    path = tmp_path / 'audit.db'
    audit = LocalAuditLog(db_path=path)
    audit.record(AuditKind.TASK, 'completed', task_id='task-106', run_id='run-106')
    assert audit.recent()[0].task_id == 'task-106'
    assert audit.verify().ok
    # Windows refuses deletion while any SQLite connection still owns a
    # handle. The caller should not need GC or private database access.
    path.unlink()
    assert not path.exists()
