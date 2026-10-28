"""Durable task admission and metadata-only receipt outbox.

An admitted row survives a crash as an uncertain execution. Neither history
display limits nor clearing confirmed history can remove its admission claim.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4
from urllib.parse import urlsplit

from .receipts import content_hash

BINDING_FIELDS = ("server_origin", "user_id", "device_id", "device_public_key", "broker_public_key")
RECEIPT_FIELDS = frozenset(("run_id", "task_id", "capability", "policy_decision", "status", "payload_hash",
    "request_hash", "result_hash", "policy_version", "consent_decision", "stdout_hash", "stderr_hash",
    "runtime_version", "exit_code", "started_at", "finished_at", "error_code",
    "skill_id", "skill_version", "skill_content_hash", "authorization_basis"))


def profile_binding(settings):
    """Resolve original ownership locally; the renderer cannot select an owner."""
    url = urlsplit(settings.server_url)
    scheme = {"ws": "http", "wss": "https"}.get(url.scheme, url.scheme)
    value = {"server_origin": f"{scheme}://{url.netloc}" if url.netloc else "",
             "user_id": settings.user_id, "device_id": settings.device_id,
             "device_public_key": settings.device_public_key, "broker_public_key": settings.server_public_key}
    return value if all(value.values()) else None


class ReceiptStorageError(RuntimeError):
    """No new operation may start until reliable storage works again."""


class ReceiptLedger:
    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self._error = ""
        self._completion_error = ""
        self._lock = threading.RLock()
        try:
            with self._db() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS local_receipts (
                    identity TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE,
                    binding TEXT NOT NULL, task TEXT NOT NULL, receipt TEXT,
                    receipt_hash TEXT, delivery_state TEXT NOT NULL,
                    acknowledgment TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)
                """)
                if 'thread_id' not in {row[1] for row in db.execute('PRAGMA table_info(local_receipts)')}:
                    db.execute("ALTER TABLE local_receipts ADD COLUMN thread_id TEXT NOT NULL DEFAULT ''")
                # A crash can lose the in-memory completion failure, but not
                # its admitted uncertain row. Require a real saved receipt
                # before allowing further writes after such a restart.
                if db.execute("SELECT 1 FROM local_receipts WHERE delivery_state='uncertain' LIMIT 1").fetchone():
                    self._completion_error = 'RECEIPT_STORAGE_UNAVAILABLE'
        except (sqlite3.Error, OSError):
            self.error = "RECEIPT_STORAGE_UNAVAILABLE"

    @property
    def error(self):
        return self._completion_error or self._error

    @error.setter
    def error(self, value):
        # Admission, acknowledgment and cleanup cannot prove that terminal
        # execution evidence can be saved, so they never clear this latch.
        self._error = value

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.path, timeout=10, uri=self.path.startswith("file:"))
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA synchronous=FULL")
            with db:
                yield db
        finally:
            db.close()

    def _execute(self, operation, *, write=False):
        with self._lock:
            try:
                with self._db() as db:
                    result = operation(db)
                if write:
                    self.error = ""
                return result
            except (sqlite3.Error, OSError) as exc:
                self.error = "RECEIPT_STORAGE_UNAVAILABLE"
                raise ReceiptStorageError(self.error) from exc

    @staticmethod
    def _binding(binding):
        return {key: str(binding.get(key, "")) for key in BINDING_FIELDS}

    @classmethod
    def _identity(cls, binding, task_id):
        return content_hash({**cls._binding(binding), "task_id": task_id})

    def admit(self, binding, task, *, thread_id=''):
        """Commit an immutable identity and execution basis before any effect."""
        def write(db):
            cursor = db.execute("INSERT OR IGNORE INTO local_receipts "
                "(identity, receipt_id, binding, task, delivery_state, thread_id) VALUES (?, ?, ?, ?, 'uncertain', ?)",
                (self._identity(binding, task["task_id"]), str(uuid4()),
                 json.dumps(self._binding(binding), sort_keys=True), json.dumps(task, sort_keys=True), thread_id))
            return cursor.rowcount == 1
        return self._execute(write, write=True)

    def complete(self, binding, receipt):
        identity = self._identity(binding, receipt["task_id"])
        metadata = {key: value for key, value in receipt.items() if key in RECEIPT_FIELDS}
        saved = False
        def write(db):
            nonlocal saved
            row = db.execute("SELECT * FROM local_receipts WHERE identity=?", (identity,)).fetchone()
            if row is None:
                raise ValueError("RECEIPT_NOT_ADMITTED")
            if row['delivery_state'] == 'cleaned':
                return None
            if row["receipt"] is None:
                value = {"receipt_id": row["receipt_id"], "binding": json.loads(row["binding"]),
                         "task": json.loads(row["task"]), "receipt": metadata}
                digest = content_hash(value)
                db.execute("UPDATE local_receipts SET receipt=?, receipt_hash=?, delivery_state='pending' WHERE identity=?",
                           (json.dumps(metadata, sort_keys=True), digest, identity))
                saved = True
                return {**value, "receipt_hash": digest}
            return self._upload(row)
        with self._lock:
            try:
                result = self._execute(write, write=True)
            except ReceiptStorageError:
                self._completion_error = 'RECEIPT_STORAGE_UNAVAILABLE'
                raise
            if saved:
                self._completion_error = ''
            return result

    @staticmethod
    def _upload(row):
        return {"receipt_id": row["receipt_id"], "binding": json.loads(row["binding"]),
                "task": json.loads(row["task"]), "receipt": json.loads(row["receipt"]),
                "receipt_hash": row["receipt_hash"]}

    def pending(self, binding):
        encoded = json.dumps(self._binding(binding), sort_keys=True)
        return self._execute(lambda db: [self._upload(row) for row in db.execute(
            "SELECT * FROM local_receipts WHERE binding=? AND delivery_state='pending' ORDER BY rowid", (encoded,))])

    def unknown_write_effects(self, binding):
        """Count all unresolved writes, independently of history pagination or ack."""
        if binding is None:
            # An offline installation still must protect every original owner.
            clause, arguments = '', ()
        else:
            clause = ' WHERE binding=?'
            arguments = (json.dumps(self._binding(binding), sort_keys=True),)
        def read(db):
            count = 0
            for row in db.execute('SELECT task, receipt, delivery_state FROM local_receipts' + clause, arguments):
                task = json.loads(row['task'])
                receipt = json.loads(row['receipt']) if row['receipt'] else {}
                # Writes and Skill scripts both leave real device effects, so
                # an unresolved outcome of either blocks a verified update.
                if task.get('capability') in ('local.files.write', 'local.skill.script') and (row['delivery_state'] == 'uncertain' or
                        receipt.get('status') == 'result_not_verified' or receipt.get('error_code') == 'RESULT_UNCERTAIN'):
                    count += 1
            return count
        return self._execute(read)

    def confirm(self, receipt_id, receipt_hash, acknowledgment, *, binding=None):
        if not acknowledgment:
            return False
        clause = " AND binding=?" if binding is not None else ""
        arguments = (acknowledgment, receipt_id, receipt_hash)
        if binding is not None:
            arguments += (json.dumps(self._binding(binding), sort_keys=True),)
        return self._execute(lambda db: db.execute("UPDATE local_receipts SET delivery_state='confirmed', acknowledgment=? "
            "WHERE receipt_id=? AND receipt_hash=? AND delivery_state IN ('pending', 'confirmed')" + clause,
            arguments).rowcount == 1, write=True)

    def clear_confirmed(self, binding=None):
        """Keep a permanent identity tombstone, never touch pending/uncertain."""
        if binding is None:
            return 0
        encoded = json.dumps(self._binding(binding), sort_keys=True)
        return self._execute(lambda db: db.execute("UPDATE local_receipts SET delivery_state='cleaned', receipt=NULL "
            "WHERE delivery_state='confirmed' AND binding=?", (encoded,)).rowcount, write=True)

    def history(self, binding=None, *, limit=20, offset=0):
        if binding is None:
            return []
        encoded = json.dumps(self._binding(binding), sort_keys=True)
        return self._execute(lambda db: [{**json.loads(row["task"]), **json.loads(row["binding"]),
            "receipt_id": row["receipt_id"], "receipt_hash": row["receipt_hash"],
            "delivery_state": row["delivery_state"], "acknowledgment": row["acknowledgment"],
            "error_code": (json.loads(row["receipt"]) if row["receipt"] else {}).get("error_code") or
                ("RESULT_UNCERTAIN" if row["delivery_state"] == 'uncertain' else ''),
            "status": (json.loads(row["receipt"]) if row["receipt"] else {}).get("status", "unknown")}
            for row in db.execute("SELECT * FROM local_receipts WHERE binding=? ORDER BY rowid DESC LIMIT ? OFFSET ?", (encoded, limit, offset))])

    def thread_history(self, binding, thread_id, run_ids=()):
        """Metadata for one original Thread, excluding keys and signed basis."""
        if binding is None:
            return []
        encoded = json.dumps(self._binding(binding), sort_keys=True)
        def read(db):
            rows = []
            for row in db.execute('SELECT * FROM local_receipts WHERE binding=? ORDER BY rowid DESC', (encoded,)):
                task = json.loads(row['task'])
                if row['thread_id'] != thread_id and task.get('run_id') not in run_ids:
                    continue
                receipt = json.loads(row['receipt']) if row['receipt'] else {}
                rows.append({key: task.get(key, '') for key in ('task_id', 'run_id', 'capability', 'logical_target')})
                rows[-1].update(status=receipt.get('status', 'unknown'), delivery_state=row['delivery_state'],
                    receipt_hash=row['receipt_hash'], error_code=receipt.get('error_code') or
                    ('RESULT_UNCERTAIN' if row['delivery_state'] == 'uncertain' else ''))
            return rows
        return self._execute(read)

    def snapshot(self, binding=None, *, offset=0):
        encoded = json.dumps(self._binding(binding), sort_keys=True) if binding is not None else ''
        try:
            counts = self._execute(lambda db: dict(db.execute(
                "SELECT delivery_state, COUNT(*) FROM local_receipts WHERE binding=? GROUP BY delivery_state", (encoded,))))
            return {"rows": self.history(binding, offset=offset), "total": sum(counts.values()),
                    **{state: counts.get(state, 0) for state in ("pending", "confirmed", "uncertain", "cleaned")},
                    "storageError": self.error}
        except ReceiptStorageError:
            return {"rows": [], "total": 0, "pending": 0, "confirmed": 0,
                    "uncertain": 0, "cleaned": 0, "storageError": self.error}
