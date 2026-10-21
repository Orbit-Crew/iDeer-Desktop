"""Fault injection only into the acceptance-owned local receipt database."""
import json
from pathlib import Path
import sqlite3
import sys

from core.receipt_ledger import ReceiptLedger, profile_binding
from core.settings import load_settings

action, config_text, *arguments = sys.argv[1:]
config = Path(config_text).resolve(strict=True)
if not (config.parent / '.issue101-owner').is_file():
    raise SystemExit('ISOLATED_PROFILE_OWNERSHIP_REQUIRED')
path = config.with_name('receipts.db')
if action == 'fault':
    mode, = arguments
    assert mode in {'none', 'admission', 'completion'}
    with sqlite3.connect(path) as db:
        db.execute('DROP TRIGGER IF EXISTS t101_admission_fault')
        db.execute('DROP TRIGGER IF EXISTS t101_completion_fault')
        if mode == 'admission':
            db.execute("CREATE TRIGGER t101_admission_fault BEFORE INSERT ON local_receipts BEGIN SELECT RAISE(FAIL, 'T101 isolated admission disk failure'); END")
        if mode == 'completion':
            db.execute("CREATE TRIGGER t101_completion_fault BEFORE UPDATE ON local_receipts WHEN NEW.delivery_state='pending' BEGIN SELECT RAISE(FAIL, 'T101 isolated completion disk failure'); END")
    print(json.dumps({'fault': mode, 'target': 'acceptance-owned receipts.db only'}))
elif action == 'history':
    ledger = ReceiptLedger(path)
    binding = profile_binding(load_settings(config))
    view = ledger.snapshot(binding)
    rows = []
    for offset in range(0, view['total'], 20):
        rows.extend(ledger.history(binding, offset=offset))
    print(json.dumps({**view, 'rows': rows}))
elif action == 'audit':
    from core.audit import LocalAuditLog
    entries = LocalAuditLog(db_path=config.with_name('audit.db')).recent(limit=10000)
    print(json.dumps([{'kind': entry.kind.value, 'action': entry.action, 'task_id': entry.task_id,
                      'run_id': entry.run_id, 'digest': entry.digest} for entry in entries if entry.task_id]))
else:
    raise SystemExit('INVALID_ACTION')
