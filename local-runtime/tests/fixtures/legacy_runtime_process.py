"""Test-only legacy controller process; never packaged or invoked by Desktop."""
import argparse
import json
import sys
import threading
from pathlib import Path

from core.audit import LocalAuditLog
from core.process_job import own_process_tree
from core.task_guard import TaskGuard
from core.tray import load_controller

parser = argparse.ArgumentParser()
parser.add_argument('--config', required=True, type=Path)
args = parser.parse_args()
job = own_process_tree()
controller = load_controller(args.config, audit=LocalAuditLog(db_path=args.config.with_name('audit.db')))
controller.client.task_guard = TaskGuard(args.config.with_name('tasks.db'))
stop = threading.Event()


def control():
    for line in sys.stdin:
        if line.strip() == '{"type":"shutdown"}':
            break
    stop.set()


threading.Thread(target=control, daemon=True).start()
try:
    controller.start()
    while not stop.is_set():
        tasks = [{'taskId': entry.task_id, 'runId': entry.run_id or '',
                  'state': entry.action, 'capability': entry.capability or ''}
                 for entry in controller.audit.recent(limit=20) if entry.task_id]
        print(json.dumps({'v': 1, 'connection': controller.status().connection, 'tasks': tasks}), flush=True)
        stop.wait(0.1)
finally:
    controller.stop()
