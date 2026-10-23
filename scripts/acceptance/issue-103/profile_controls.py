"""Read only synthetic execution records; change only its local write policy."""
import json
from pathlib import Path
import sys
from core.audit import LocalAuditLog
from core.receipt_ledger import ReceiptLedger, profile_binding
from core.settings import load_settings

action, config_text, state_text, *arguments = sys.argv[1:]
config, state = Path(config_text).resolve(strict=True), Path(state_text).resolve(strict=True)
manifest = json.loads((state / 'ready.json').read_text())
settings = load_settings(config)
if (not (config.parent / '.issue102-owner').is_file() or settings.server_url != manifest['origin']
        or settings.user_id not in [row['id'] for row in manifest['identities'].values()]):
    raise SystemExit('SYNTHETIC_PROFILE_REQUIRED')
if action == 'history':
    ledger = ReceiptLedger(config.with_name('receipts.db'))
    binding = profile_binding(settings)
    view = ledger.snapshot(binding)
    view['rows'] = [row for offset in range(0, view['total'], 20) for row in ledger.history(binding, offset=offset)]
    print(json.dumps(view))
elif action == 'audit':
    log = LocalAuditLog(db_path=config.with_name('audit.db'))
    print(json.dumps({'integrity': log.verify().ok, 'rows': [r.as_dict() for r in log.recent(limit=10000) if r.task_id]}))
elif action == 'policy':
    mode, = arguments
    assert mode in {'deny', 'ask_first'}
    settings.rules['local.files.write'] = mode
    settings.save(config)
    print(json.dumps({'operation': 'local.files.write', 'rule': mode}))
else:
    raise SystemExit('INVALID_ACTION')
