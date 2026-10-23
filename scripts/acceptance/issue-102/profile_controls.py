"""Observe and fault only a marked, synthetic Issue 102 Runtime profile."""
import json
from pathlib import Path
import sqlite3
import sys

from core.audit import LocalAuditLog
from core.receipt_ledger import ReceiptLedger, profile_binding
from core.settings import load_settings

action, config_text, *arguments = sys.argv[1:]
config = Path(config_text).resolve(strict=True)
if not (config.parent / '.issue102-owner').is_file():
    raise SystemExit('ISOLATED_PROFILE_OWNERSHIP_REQUIRED')
settings = load_settings(config)
if not settings.business_token_ref.startswith('t100-'):
    raise SystemExit('SYNTHETIC_IDENTITY_REQUIRED')
database = config.with_name('receipts.db')
if action == 'fault':
    mode, = arguments
    assert mode in {'none', 'admission', 'completion'}
    with sqlite3.connect(database) as db:
        db.execute('DROP TRIGGER IF EXISTS t102_admission_fault')
        db.execute('DROP TRIGGER IF EXISTS t102_completion_fault')
        if mode == 'admission':
            db.execute("CREATE TRIGGER t102_admission_fault BEFORE INSERT ON local_receipts BEGIN SELECT RAISE(FAIL, 'T102 isolated admission failure'); END")
        elif mode == 'completion':
            db.execute("CREATE TRIGGER t102_completion_fault BEFORE UPDATE ON local_receipts WHEN NEW.delivery_state='pending' BEGIN SELECT RAISE(FAIL, 'T102 isolated completion failure'); END")
    print(json.dumps({'fault': mode, 'target': 'marked synthetic receipts.db'}))
elif action == 'history':
    ledger = ReceiptLedger(database)
    binding = profile_binding(settings)
    view = ledger.snapshot(binding)
    view['rows'] = [row for offset in range(0, view['total'], 20) for row in ledger.history(binding, offset=offset)]
    print(json.dumps(view))
elif action == 'audit':
    log = LocalAuditLog(db_path=config.with_name('audit.db'))
    entries = [entry.as_dict() for entry in log.recent(limit=10000) if entry.task_id]
    print(json.dumps({'integrity': log.verify().ok, 'rows': entries}))
elif action == 'policy':
    mode, = arguments
    assert mode in {'deny', 'ask_first'}
    settings.rules['local.files.write'] = mode
    settings.save(config)
    print(json.dumps({'operation': 'local.files.write', 'rule': mode}))
else:
    raise SystemExit('INVALID_ACTION')
