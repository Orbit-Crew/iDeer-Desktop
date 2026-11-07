"""Explicit local knowledge import: device freeze plus platform registration (#112).

The user explicitly picks files inside the confirmed workspace; the device
reads them, computes content fingerprints, and registers one immutable
private KnowledgeBase Revision manifest on the platform. Original bytes and
the device-side index never upload: the registration request carries only
document identity fields (plain file name, size, MIME type, SHA-256), and the
path-to-hash mapping stays a device-local display fact for this identity.
"""
from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable

from .compat import is_junction
from .document_parse import parse_document, parse_summary
from .files import FileAccessError

# Frozen cross-repo contract (server backend/app/agentplatform/knowledge):
# the platform accepts at most 200 documents per import, each within the
# document upload size cap, with the same supported-extension whitelist.
MAX_IMPORT_DOCUMENTS = 200
MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024
SUPPORTED_EXTENSIONS = {".csv", ".doc", ".docx", ".json", ".md", ".pdf", ".ppt", ".pptx", ".txt", ".xls", ".xlsx"}
DOCUMENT_FIELDS = ("filename", "sha256", "bytes", "mime", "parse")

# Issue 96: the document library's recursive folder import. One job walks a
# confirmed workspace folder, dedups by content fingerprint against the
# registered rows of the same KB, and registers the rest in batches that
# respect the frozen per-import document cap.
MAX_FOLDER_IMPORT_FILES = 1000
MAX_SOURCE_PATHS = MAX_IMPORT_DOCUMENTS
MAX_SOURCE_PATH_CHARS = 1024
FOLDER_FAILURE_VIEW_LIMIT = 50
KB_ID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class KnowledgeImportError(RuntimeError):
    """A fixed-category import failure; safe to surface as an error code."""


def category_for(error: BaseException) -> str:
    """Map device-side failures onto the fixed import categories."""
    if isinstance(error, KnowledgeImportError):
        return str(error)
    if isinstance(error, FileAccessError):
        mapped = {
            "WORKSPACE_UNAVAILABLE": "KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE",
            "OUTSIDE_ALLOWED_ROOTS": "KNOWLEDGE_IMPORT_OUTSIDE_ALLOWED_ROOTS",
            "PROTECTED_PATH": "KNOWLEDGE_IMPORT_PROTECTED_PATH",
        }
        return mapped.get(error.code, "KNOWLEDGE_IMPORT_FILE_UNAVAILABLE")
    return "KNOWLEDGE_IMPORT_FAILED"


def logical_paths_for(grant: dict[str, Any], physical_paths: list[str]) -> list[str]:
    """Map picked physical files onto the confirmed workspace logical view.

    Every path is verified against the selected root and its recorded
    directory generation before any read: a file outside the confirmed
    workspace, or reached through a link or junction, is refused outright.
    """
    root = Path(grant["physical_root"])
    identity = [root.stat().st_dev, root.stat().st_ino]
    if list(grant.get("identity") or []) != identity:
        raise KnowledgeImportError("KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE")
    logical: list[str] = []
    for raw in physical_paths:
        if not isinstance(raw, str) or not raw or len(raw) > 32768 or "\x00" in raw:
            raise KnowledgeImportError("KNOWLEDGE_IMPORT_OUTSIDE_ALLOWED_ROOTS")
        picked = Path(raw)
        # Check every ancestor before resolve, so a junctioned selection can
        # never masquerade as a workspace member (same rule as select()).
        for component in [*reversed(picked.parents), picked]:
            if component.is_symlink() or is_junction(component):
                raise KnowledgeImportError("KNOWLEDGE_IMPORT_OUTSIDE_ALLOWED_ROOTS")
        try:
            resolved = picked.resolve(strict=True)
            relative = resolved.relative_to(root)
        except (OSError, ValueError) as exc:
            raise KnowledgeImportError("KNOWLEDGE_IMPORT_OUTSIDE_ALLOWED_ROOTS") from exc
        logical.append(f"{grant['logical_root']}/{relative.as_posix()}")
    if len(logical) != len(set(logical)):
        raise KnowledgeImportError("KNOWLEDGE_IMPORT_DUPLICATE_PATH")
    return logical


def build_manifest(files: Any, logical_paths: list[str]) -> list[dict[str, Any]]:
    """Read each workspace file once, freeze its identity, and parse it locally.

    Reading reuses the workspace store boundary, so protected names, links
    and out-of-root paths fail closed before a single byte leaves the device.
    Since #81 the device also really extracts PDF/DOCX/XLSX/CSV/text here:
    each entry carries an honest per-document parse record (parser identity,
    page/table layout anchors, fixed failure reason) that stays a
    device-local display fact, while the platform registration payload keeps
    carrying identity fields only. A document the engine cannot parse never
    fails the import: its record says so instead.
    """
    if len(logical_paths) > MAX_IMPORT_DOCUMENTS:
        raise KnowledgeImportError("KNOWLEDGE_IMPORT_TOO_MANY_DOCUMENTS")
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for logical_path in logical_paths:
        filename = logical_path.rstrip("/").rsplit("/", 1)[-1]
        if not filename or Path(filename).suffix.lower() not in SUPPORTED_EXTENSIONS:
            raise KnowledgeImportError("KNOWLEDGE_IMPORT_UNSUPPORTED_TYPE")
        try:
            raw = files.read_bytes(logical_path, max_bytes=MAX_IMPORT_FILE_BYTES + 1)
        except FileAccessError as exc:
            raise KnowledgeImportError(category_for(exc)) from exc
        if len(raw) > MAX_IMPORT_FILE_BYTES:
            raise KnowledgeImportError("KNOWLEDGE_IMPORT_FILE_TOO_LARGE")
        digest = hashlib.sha256(raw).hexdigest()
        if digest in seen:
            raise KnowledgeImportError("KNOWLEDGE_IMPORT_DUPLICATE_CONTENT")
        seen.add(digest)
        entries.append({
            "filename": filename,
            "sha256": digest,
            "bytes": len(raw),
            "mime": mimetypes.guess_type(filename)[0] or "application/octet-stream",
            "parse": parse_summary(parse_document(raw, filename)),
        })
    return entries


def registration_payload(entries: list[dict[str, Any]], device_id: str) -> dict[str, Any]:
    """The complete registration request: identity fields only, never content."""
    return {
        "documents": [dict(filename=entry["filename"], content_hash=entry["sha256"],
                           size_bytes=entry["bytes"], mime_type=entry["mime"]) for entry in entries],
        "device_id": device_id[:128],
    }


# --- Issue 96: the document library's recursive folder import ----------------

def walk_import_folder(grant: dict[str, Any], physical_folder: str) -> dict[str, Any]:
    """Walk one confirmed workspace folder recursively for the doc library.

    The folder itself must live inside the confirmed workspace (every ancestor
    checked for links or junctions before resolution, the same rule as a
    picked file), so a junctioned selection can never widen the import.
    Candidates carry the extension whitelist; protected directory names
    (``.git``, ``node_modules``, …), linked files and junctioned subtrees are
    pruned and counted instead of followed. The walk stops at the job cap and
    reports ``truncated`` rather than running without bound.
    """
    from .file_service import WorkspaceFileStore
    root = Path(grant["physical_root"])
    try:
        identity = [root.stat().st_dev, root.stat().st_ino]
    except OSError as exc:
        # The root vanished after confirmation (unmount, external wipe): an
        # honest category keeps the worker alive to fail the job instead of
        # an escaping FileNotFoundError leaving a stuck running job.
        raise KnowledgeImportError("KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE") from exc
    if list(grant.get("identity") or []) != identity:
        raise KnowledgeImportError("KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE")
    if not isinstance(physical_folder, str) or not physical_folder \
            or len(physical_folder) > 32768 or "\x00" in physical_folder:
        raise KnowledgeImportError("KNOWLEDGE_IMPORT_OUTSIDE_ALLOWED_ROOTS")
    folder = Path(physical_folder)
    for component in [*reversed(folder.parents), folder]:
        if component.is_symlink() or is_junction(component):
            raise KnowledgeImportError("KNOWLEDGE_IMPORT_OUTSIDE_ALLOWED_ROOTS")
    try:
        resolved = folder.resolve(strict=True)
        relative = resolved.relative_to(root)
    except (OSError, ValueError) as exc:
        raise KnowledgeImportError("KNOWLEDGE_IMPORT_OUTSIDE_ALLOWED_ROOTS") from exc
    if not resolved.is_dir():
        raise KnowledgeImportError("KNOWLEDGE_IMPORT_OUTSIDE_ALLOWED_ROOTS")
    if WorkspaceFileStore.protected(resolved):
        raise KnowledgeImportError("KNOWLEDGE_IMPORT_PROTECTED_PATH")
    logical_root = str(grant["logical_root"]).rstrip("/")
    folder_logical = logical_root + ("/" + relative.as_posix() if relative.parts else "")
    candidates: list[str] = []
    skipped_unsupported = 0
    skipped_links = 0
    truncated = False
    for current, dirs, names in os.walk(resolved):
        keep: list[str] = []
        for name in sorted(dirs):
            path = Path(current) / name
            if path.is_symlink() or is_junction(path):
                skipped_links += 1
                continue
            # Protected names prune silently, exactly like the workspace
            # store's own listing: they are by-design exclusions.
            if not WorkspaceFileStore.protected(path):
                keep.append(name)
        dirs[:] = keep
        for name in sorted(names):
            path = Path(current) / name
            if path.is_symlink() or is_junction(path):
                skipped_links += 1
                continue
            if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
                skipped_unsupported += 1
                continue
            if len(candidates) >= MAX_FOLDER_IMPORT_FILES:
                truncated = True
                break
            try:
                file_relative = path.resolve().relative_to(root).as_posix()
            except (OSError, ValueError):
                skipped_links += 1
                continue
            candidates.append(f"{logical_root}/{file_relative}")
        if truncated:
            break
    return dict(folder=folder_logical, logical_paths=candidates, truncated=truncated,
                skippedUnsupported=skipped_unsupported, skippedLinks=skipped_links)


def build_folder_entries(files: Any, logical_paths: list[str], known_hashes: set[str],
                         canceled: Callable[[], bool] | None = None,
                         progress: Callable[[int], None] | None = None) -> dict[str, Any]:
    """Per-file manifest for one folder import: a bad file fails alone.

    Unlike ``build_manifest`` (one explicit user pick, fail-closed on the
    first bad file), a folder contains whatever the user has, so each file is
    read through the workspace store on its own: a protected, unreadable or
    oversized file becomes an honest per-file failure with its fixed category,
    and a fingerprint already registered for this KB — or already seen inside
    the folder — is skipped and counted. The caller receives the manifest
    entries plus the aligned logical paths for the record's source display.
    ``canceled`` is checked before every file; ``progress`` reports how many
    files were examined so far.
    """
    stop = canceled or (lambda: False)
    report = progress or (lambda done: None)
    entries: list[dict[str, Any]] = []
    paths: list[str] = []
    failures: list[dict[str, str]] = []
    duplicates = 0
    seen: set[str] = set()
    examined = 0
    for logical_path in logical_paths:
        if stop():
            break
        filename = logical_path.rstrip("/").rsplit("/", 1)[-1]
        try:
            raw = files.read_bytes(logical_path, max_bytes=MAX_IMPORT_FILE_BYTES + 1)
        except FileAccessError as exc:
            failures.append({"filename": filename, "errorCode": category_for(exc)})
        else:
            if len(raw) > MAX_IMPORT_FILE_BYTES:
                failures.append({"filename": filename, "errorCode": "KNOWLEDGE_IMPORT_FILE_TOO_LARGE"})
            else:
                digest = hashlib.sha256(raw).hexdigest()
                if digest in seen or digest in known_hashes:
                    duplicates += 1
                else:
                    seen.add(digest)
                    entries.append({
                        "filename": filename,
                        "sha256": digest,
                        "bytes": len(raw),
                        "mime": mimetypes.guess_type(filename)[0] or "application/octet-stream",
                        "parse": parse_summary(parse_document(raw, filename)),
                    })
                    paths.append(logical_path)
        examined += 1
        report(examined)
    return dict(entries=entries, paths=paths, failures=failures, duplicates=duplicates,
                canceled=stop(), examined=examined)


def physical_paths_for(grant: dict[str, Any], logical_paths: Any) -> list[str]:
    """Map a failed record's stored logical display paths back to physical
    paths for a retry. The stored paths are workspace-relative display facts;
    anything malformed, outside the confirmed logical root, or carrying
    traversal components refuses instead of guessing."""
    if not isinstance(logical_paths, list) or not 1 <= len(logical_paths) <= MAX_IMPORT_DOCUMENTS:
        raise KnowledgeImportError("KNOWLEDGE_IMPORT_NO_SOURCE")
    root_logical = str(grant["logical_root"]).rstrip("/")
    physical_root = Path(grant["physical_root"])
    physicals: list[str] = []
    for logical in logical_paths:
        if not isinstance(logical, str) or len(logical) > MAX_SOURCE_PATH_CHARS \
                or not logical.startswith(root_logical + "/"):
            raise KnowledgeImportError("KNOWLEDGE_IMPORT_NO_SOURCE")
        parts = logical[len(root_logical) + 1:].split("/")
        if any(not part or part in {".", ".."} or "\\" in part or "\x00" in part for part in parts):
            raise KnowledgeImportError("KNOWLEDGE_IMPORT_NO_SOURCE")
        physicals.append(str(physical_root.joinpath(*parts)))
    return physicals


class KnowledgeImportRegistry:
    """Device-local display facts for one identity's explicit imports.

    A failed import is recorded as failed with its real error category: the
    display must never impersonate a registered revision. Rows keep the
    manifest identity so a later view can compare hashes after the originals
    drift, but never the physical paths or any file content.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self._error = ""
        self._lock = threading.RLock()
        try:
            with self._db() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS knowledge_imports (
                    identity TEXT PRIMARY KEY, binding TEXT NOT NULL,
                    kb_id TEXT NOT NULL, revision_id TEXT NOT NULL DEFAULT '',
                    revision_no INTEGER NOT NULL DEFAULT 0, manifest_hash TEXT NOT NULL DEFAULT '',
                    document_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
                    error_code TEXT NOT NULL DEFAULT '', documents TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
                # Issue 96: the workspace-logical source and the platform
                # project identity are device-local display facts kept with
                # the row; older databases gain the columns with empty defaults.
                for column in ("source TEXT NOT NULL DEFAULT ''", "project_id TEXT NOT NULL DEFAULT ''"):
                    try:
                        db.execute(f"ALTER TABLE knowledge_imports ADD COLUMN {column}")
                    except sqlite3.OperationalError:
                        pass
        except (sqlite3.Error, OSError):
            self._error = "IMPORT_STORAGE_UNAVAILABLE"

    @property
    def error(self) -> str:
        return self._error

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

    def _execute(self, operation):
        with self._lock:
            try:
                with self._db() as db:
                    result = operation(db)
                self._error = ""
                return result
            except (sqlite3.Error, OSError) as exc:
                self._error = "IMPORT_STORAGE_UNAVAILABLE"
                raise KnowledgeImportError(self._error) from exc

    @staticmethod
    def _encoded(binding) -> str:
        return json.dumps(binding, sort_keys=True)

    def record(self, binding, row: dict[str, Any]) -> bool:
        """Keep the first fact per (identity, import attempt); later rows win a new identity."""
        fields = {
            "kb_id": str(row.get("kb_id", ""))[:128],
            "revision_id": str(row.get("revision_id", ""))[:128],
            "revision_no": int(row.get("revision_no", 0) or 0),
            "manifest_hash": str(row.get("manifest_hash", ""))[:64],
            "document_count": int(row.get("document_count", 0) or 0),
            "status": "registered" if row.get("status") == "registered" else "failed",
            "error_code": str(row.get("error_code", ""))[:128],
            "documents": json.dumps([{key: document.get(key) for key in DOCUMENT_FIELDS}
                                     for document in (row.get("documents") or [])][:MAX_IMPORT_DOCUMENTS]),
        }
        # Issue 96: the workspace-logical source (where a folder batch came
        # from, kept so a failed record can be retried) and the platform
        # project identity are display facts. The identity hash includes the
        # source only when present, so legacy attempt dedup stays byte-stable.
        source = row.get("source") if isinstance(row.get("source"), dict) else None
        paths = [str(path)[:MAX_SOURCE_PATH_CHARS] for path in (source or {}).get("paths") or []
                 if isinstance(path, str) and path][:MAX_SOURCE_PATHS]
        fields["source"] = json.dumps({"kind": str((source or {}).get("kind", ""))[:16],
                                       "folder": str((source or {}).get("folder", ""))[:MAX_SOURCE_PATH_CHARS],
                                       "paths": paths}) if source else ""
        project_id = row.get("project_id")
        fields["project_id"] = project_id[:128] if isinstance(project_id, str) else ""
        identity_material = [self._encoded(binding), fields["kb_id"], fields["status"], fields["error_code"],
                             sorted(document["sha256"] for document in json.loads(fields["documents"]))]
        if fields["source"]:
            identity_material.append(fields["source"])
        fields["identity"] = hashlib.sha256(json.dumps(identity_material).encode()).hexdigest()

        def write(db):
            cursor = db.execute(
                "INSERT OR IGNORE INTO knowledge_imports (identity, binding, kb_id, revision_id, revision_no,"
                " manifest_hash, document_count, status, error_code, documents, source, project_id)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (fields["identity"], self._encoded(binding), fields["kb_id"], fields["revision_id"],
                 fields["revision_no"], fields["manifest_hash"], fields["document_count"],
                 fields["status"], fields["error_code"], fields["documents"],
                 fields["source"], fields["project_id"]))
            return cursor.rowcount == 1

        return self._execute(write)

    @staticmethod
    def _source_view(row, *, with_paths: bool) -> dict[str, Any] | None:
        """The record's stored source display fact.

        The status wire carries only the folder and the path count — the
        stored logical paths are a device-side retry fact, never a wire fact.
        ``with_paths`` is for the device-side retry lookup only.
        """
        try:
            source = json.loads(row["source"]) if row["source"] else None
        except (ValueError, TypeError):
            source = None
        if not isinstance(source, dict) or not isinstance(source.get("paths"), list):
            return None
        view = dict(kind=str(source.get("kind", ""))[:16], folder=str(source.get("folder", ""))[:MAX_SOURCE_PATH_CHARS],
                    pathCount=len(source["paths"]))
        if with_paths:
            view["paths"] = [str(path) for path in source["paths"]][:MAX_SOURCE_PATHS]
        return view

    @classmethod
    def _view(cls, row, *, with_source_paths: bool = False) -> dict[str, Any]:
        try:
            documents = json.loads(row["documents"])
        except (ValueError, TypeError):
            documents = []
        views = []
        for document in documents:
            if not isinstance(document, dict):
                continue
            view = dict(filename=document.get("filename", ""), sha256=document.get("sha256", ""),
                        bytes=document.get("bytes", 0), mime=document.get("mime", ""))
            # Rows recorded before #81 carry no parse facts; they stay displayable.
            if isinstance(document.get("parse"), dict):
                view["parse"] = document["parse"]
            views.append(view)
        project_id = row["project_id"] if "project_id" in row.keys() else ""
        return {
            "id": row["identity"], "kbId": row["kb_id"], "revisionId": row["revision_id"],
            "revisionNo": row["revision_no"], "manifestHash": row["manifest_hash"],
            "documentCount": row["document_count"], "status": row["status"],
            "errorCode": row["error_code"], "createdAt": row["created_at"],
            "projectId": project_id if isinstance(project_id, str) else "",
            "source": cls._source_view(row, with_paths=with_source_paths),
            "documents": views,
        }

    def view(self, binding, limit: int = 20) -> list[dict[str, Any]]:
        """Rows for the current identity only; another account never inherits them."""

        def read(db):
            rows = db.execute("SELECT * FROM knowledge_imports WHERE binding=? ORDER BY rowid DESC LIMIT ?",
                              (self._encoded(binding), int(limit))).fetchall()
            return [self._view(row) for row in rows]

        return self._execute(read)

    def registered_hashes(self, binding, kb_id: str) -> set[str]:
        """Content fingerprints already registered for this identity and KB —
        the folder import's cross-import dedup set (#96)."""

        def read(db):
            rows = db.execute("SELECT documents FROM knowledge_imports WHERE binding=? AND kb_id=? AND status='registered'",
                              (self._encoded(binding), str(kb_id)[:128])).fetchall()
            hashes: set[str] = set()
            for row in rows:
                try:
                    documents = json.loads(row["documents"])
                except (ValueError, TypeError):
                    continue
                for document in documents:
                    if isinstance(document, dict) and isinstance(document.get("sha256"), str):
                        hashes.add(document["sha256"])
            return hashes

        return self._execute(read)

    def fetch(self, binding, ids: list[str]) -> list[dict[str, Any]]:
        """Binding-scoped rows by identity, in the caller's order, with the
        stored source paths for the device-side retry seam (#96)."""
        wanted = [str(identity)[:128] for identity in (ids or [])][:100]

        def read(db):
            found: dict[str, dict[str, Any]] = {}
            for identity in wanted:
                if identity in found:
                    continue
                row = db.execute("SELECT * FROM knowledge_imports WHERE binding=? AND identity=?",
                                 (self._encoded(binding), identity)).fetchone()
                if row is not None:
                    found[identity] = self._view(row, with_source_paths=True)
            return [found[identity] for identity in wanted if identity in found]

        return self._execute(read)

    def delete(self, binding, ids: list[str]) -> int:
        """Remove selected display rows of this identity only. The platform
        keeps every registered revision; a delete never calls the Server."""

        def write(db):
            total = 0
            for identity in [str(item)[:128] for item in (ids or [])][:100]:
                total += db.execute("DELETE FROM knowledge_imports WHERE binding=? AND identity=?",
                                    (self._encoded(binding), identity)).rowcount
            return total

        return self._execute(write)

    def find_registration(self, binding, revision_id: str, manifest_hash: str) -> dict[str, Any] | None:
        """The registered frozen revision for retrieval revalidation (#113).

        Lookup is binding-scoped: only a revision this identity registered on
        this device can ever be re-validated here, so a server request about
        an unknown or foreign manifest fails closed.
        """

        def read(db):
            row = db.execute(
                "SELECT * FROM knowledge_imports WHERE binding=? AND revision_id=? AND manifest_hash=? AND status='registered'"
                " ORDER BY rowid DESC LIMIT 1",
                (self._encoded(binding), str(revision_id)[:128], str(manifest_hash)[:64])).fetchone()
            return self._view(row) if row is not None else None

        return self._execute(read)

    def find_registration_by_revision(self, binding, kb_id: str, revision_id: str) -> dict[str, Any] | None:
        """The registered frozen revision behind an explicit publication (#115).

        Publication content must be the exact bytes behind one registered
        import, so the lookup stays binding-scoped like every other registry
        read: a revision this identity never registered cannot be published.
        """

        def read(db):
            row = db.execute(
                "SELECT * FROM knowledge_imports WHERE binding=? AND kb_id=? AND revision_id=? AND status='registered'"
                " ORDER BY rowid DESC LIMIT 1",
                (self._encoded(binding), str(kb_id)[:128], str(revision_id)[:128])).fetchone()
            return self._view(row) if row is not None else None

        return self._execute(read)


class KnowledgeFolderImport:
    """One background folder import job with progress and cancel (#96).

    A large library folder does not fit the single-slot request pattern: the
    job runs on its own daemon thread, reports its progress through the
    status snapshot, and honors a cancel command between files and batches.
    Exactly one job runs at a time; the finished job stays visible (with its
    honest completed/canceled/failed outcome) until the next import replaces
    it. Originals stay local: the job only reads through the confirmed
    workspace store and registers identity manifests on the platform.
    """

    def __init__(self, register_entries, knowledge_files, registry) -> None:
        self._register_entries = register_entries
        self._knowledge_files = knowledge_files
        self._registry = registry
        self._lock = threading.Lock()
        self._job: dict[str, Any] | None = None
        self._cancel = threading.Event()

    @staticmethod
    def _empty_job(kb_id: str) -> dict[str, Any]:
        return dict(state='running', kbId=kb_id, folder='', totalFiles=0, processedFiles=0,
                    registeredBatches=0, registeredDocuments=0, failedBatches=0,
                    skippedDuplicates=0, skippedUnsupported=0, skippedLinks=0,
                    truncated=False, error='', failures=[])

    def status(self) -> dict[str, Any] | None:
        with self._lock:
            if self._job is None:
                return None
            view = dict(self._job)
            view['failures'] = list(self._job['failures'])
            return view

    def cancel(self) -> bool:
        """Ask the running job to stop at the next file or batch boundary."""
        with self._lock:
            running = self._job is not None and self._job['state'] == 'running'
        if running:
            self._cancel.set()
        return running

    def start(self, kb_id: str, physical_folder: str) -> dict[str, Any]:
        """Start one folder import; refuses before anything runs when the
        session/workspace boundary is unavailable or a job is already running.
        The walk itself runs on the worker, so a refusal inside the confirmed
        boundary surfaces as the job's failed state, not a start exception."""
        if not isinstance(kb_id, str) or not KB_ID_PATTERN.fullmatch(kb_id):
            raise KnowledgeImportError("KNOWLEDGE_IMPORT_KB_INVALID")
        try:
            self._knowledge_files()
        except (FileAccessError, KnowledgeImportError) as exc:
            raise KnowledgeImportError(category_for(exc)) from exc
        with self._lock:
            if self._job is not None and self._job['state'] == 'running':
                raise KnowledgeImportError("KNOWLEDGE_IMPORT_BUSY")
            self._cancel = threading.Event()
            self._job = self._empty_job(kb_id)
        worker = threading.Thread(target=self._run, args=(kb_id, physical_folder), daemon=True)
        try:
            worker.start()
        except BaseException:
            # A worker that cannot start must never leave a running phantom:
            # the slot frees and nothing shows as an uncancelable import.
            with self._lock:
                self._job = None
            raise
        return self.status()

    def _update(self, **fields) -> None:
        with self._lock:
            if self._job is not None:
                self._job.update(fields)

    def _run(self, kb_id: str, physical_folder: str) -> None:
        try:
            settings, grant, files = self._knowledge_files()
            walk = walk_import_folder(grant, physical_folder)
        except (FileAccessError, KnowledgeImportError) as exc:
            self._update(state='failed', error=category_for(exc))
            return
        self._update(folder=walk['folder'], totalFiles=len(walk['logical_paths']),
                     truncated=walk['truncated'], skippedUnsupported=walk['skippedUnsupported'],
                     skippedLinks=walk['skippedLinks'])
        try:
            from .receipt_ledger import profile_binding
            known = self._registry.registered_hashes(profile_binding(settings), kb_id)
            built = build_folder_entries(files, walk['logical_paths'], known,
                                         canceled=self._cancel.is_set,
                                         progress=lambda done: self._update(processedFiles=done))
            self._update(skippedDuplicates=built['duplicates'],
                         failures=built['failures'][:FOLDER_FAILURE_VIEW_LIMIT])
            if built['canceled'] or self._cancel.is_set():
                self._update(state='canceled')
                return
            source_base = {'kind': 'folder', 'folder': walk['folder']}
            batches = 0
            registered = 0
            for index in range(0, len(built['entries']), MAX_IMPORT_DOCUMENTS):
                if self._cancel.is_set():
                    self._update(state='canceled')
                    return
                chunk = built['entries'][index:index + MAX_IMPORT_DOCUMENTS]
                try:
                    self._register_entries(kb_id, chunk,
                                           source=dict(source_base,
                                                       paths=built['paths'][index:index + MAX_IMPORT_DOCUMENTS]))
                except Exception as exc:
                    # Only fixed categories cross the Desktop boundary; the
                    # same refusal would hit every later batch, so the job
                    # stops here and reports honestly. Already-registered
                    # batches stay registered.
                    category = str(exc)
                    self._update(failedBatches=1, state='failed',
                                 error=category if re.fullmatch(r"[A-Z][A-Z0-9_]+", category)
                                 else "KNOWLEDGE_IMPORT_FAILED")
                    return
                batches += 1
                registered += len(chunk)
                self._update(registeredBatches=batches, registeredDocuments=registered)
            self._update(state='completed')
        except KnowledgeImportError as exc:
            self._update(state='failed', error=str(exc))
        except Exception:
            self._update(state='failed', error="KNOWLEDGE_IMPORT_FAILED")
