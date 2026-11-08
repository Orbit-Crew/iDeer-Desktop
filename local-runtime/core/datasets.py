"""Table dataset import: device-side XLSX/CSV parsing into real datasets (#102).

Real local parsing for the table formats the device claims to support,
replacing the register-the-suffix-only behavior for tables: each import reads
the picked file once, computes its SHA-256 content fingerprint, and builds
the per-sheet table facts — headers, recognized column types (number /
boolean / datetime / string), and honest row/column counts. The engine is a
pure, deterministic function of (bytes, filename): the same inputs always
produce the same sheet facts and fingerprints, so re-reading the same file
answers the same identity. Nothing here touches the network, and nothing
persists row data — the registry keeps identity, schema and counts only, and
the original file stays on this machine.

Type inference reads cell text only, stdlib-only and honest: a boolean column
is true/false (case-insensitive), a number column parses as a decimal float
(leading-zero codes stay strings — they are identifiers, not quantities), a
datetime column parses as ISO-8601 (``Z`` offsets included), and anything
mixed or unclassifiable stays string. What was inferred is recorded next to
every column; an XLSX date stored as a serial number therefore reports
``number`` — the recorded fact, not a guess.

Results never raise for content problems. A table the device cannot honestly
parse answers with a fixed ``DATASETS_*`` reason code, which the import flow
records as a failed row instead of pretending a dataset exists.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import sqlite3
import threading
import xml.etree.ElementTree as ET
import zipfile
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, NamedTuple

# Aligned with the frozen #112 import bound: the engine refuses the same
# per-file ceiling the knowledge import already enforces (defense in depth).
MAX_DATASET_FILE_BYTES = 50 * 1024 * 1024
MAX_DATASET_SHEETS = 32
MAX_DATASET_ROWS = 100_000
MAX_DATASET_COLUMNS = 128
MAX_DATASET_HEADER_CHARS = 128
# The bounded wire projection of one sheet's inferred schema ("header:type"
# pairs); the registry keeps the full bounded arrays, the display keeps the
# summary — a status frame must never grow with a workbook's column count.
MAX_DATASET_SCHEMA_CHARS = 500

DATASET_TYPES = ("number", "boolean", "datetime", "string")
XLSX_DATASET_PARSER = "xlsx-ooxml"
CSV_DATASET_PARSER = "csv-stdlib"
STDLIB_PARSER_VERSION = "1"

_X = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_XR = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

SUPPORTED_DATASET_EXTENSIONS = frozenset({".xlsx", ".csv"})

# Fixed categories: the only strings that cross the Desktop boundary.
DATASETS_FILE_TOO_LARGE = "DATASETS_FILE_TOO_LARGE"
DATASETS_FORMAT_UNSUPPORTED = "DATASETS_FORMAT_UNSUPPORTED"
DATASETS_PARSE_FAILED = "DATASETS_PARSE_FAILED"
DATASETS_FILE_UNREADABLE = "DATASETS_FILE_UNREADABLE"
DATASETS_IDENTITY_CHANGED = "DATASETS_IDENTITY_CHANGED"
DATASETS_UNAUTHENTICATED = "DATASETS_UNAUTHENTICATED"
DATASETS_STORAGE_UNAVAILABLE = "DATASETS_STORAGE_UNAVAILABLE"
DATASETS_NOT_FOUND = "DATASETS_NOT_FOUND"
DATASETS_COMMAND_INVALID = "DATASETS_COMMAND_INVALID"
DATASETS_FAILED = "DATASETS_FAILED"

_NUMBER = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")
_LEADING_ZERO = re.compile(r"^[+-]?0\d+$")
_BOOLEAN = frozenset({"true", "false"})
_DATETIME = re.compile(
    r"^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$")


class DatasetError(RuntimeError):
    """A fixed-category datasets failure; safe to surface as an error code."""


def category_for(error: BaseException) -> str:
    """Map device-side failures onto the fixed datasets categories."""
    if isinstance(error, DatasetError):
        return str(error)
    return DATASETS_FAILED


class _PartTooLarge(RuntimeError):
    """An inner OOXML part decompresses beyond the per-file bound."""


class _SheetTable(NamedTuple):
    """One parsed sheet: header row, data rows, and honest bound markers."""

    name: str
    headers: list[str]
    rows: list[list[str]]
    col_count: int
    truncated: bool
    columns_truncated: bool = False


def _xml_part(archive: zipfile.ZipFile, name: str) -> ET.Element:
    """One zip part parsed as OOXML XML; DOCTYPEs are refused, not expanded
    (the same zip+ElementTree discipline proven by the #81 engine)."""
    info = archive.getinfo(name)
    if info.file_size > MAX_DATASET_FILE_BYTES:
        raise _PartTooLarge(name)
    data = archive.read(name)
    if b"<!DOCTYPE" in data[:4096] or b"<!ENTITY" in data[:4096]:
        raise ET.ParseError(name)
    return ET.fromstring(data)


def _cell_value(cell: ET.Element, shared: list[str]) -> str:
    """One cell's text: shared strings, inline strings, booleans and numbers.

    A boolean cell renders as ``true``/``false`` so inference sees the type
    the workbook actually declared; everything else is its stored text.
    """
    kind = cell.get("t")
    if kind == "inlineStr":
        inline = cell.find(f"{{{_X}}}is")
        return "".join(node.text or "" for node in inline.iter(f"{{{_X}}}t")) if inline is not None else ""
    value = cell.find(f"{{{_X}}}v")
    if value is None or value.text is None:
        return ""
    if kind == "b":
        return "true" if value.text.strip() == "1" else "false"
    if kind == "s":
        try:
            index = int(value.text)
        except ValueError:
            return ""
        return shared[index] if 0 <= index < len(shared) else ""
    return value.text


def _column_index(reference: str, position: int) -> int:
    """The 0-based column a cell reference names; ordering is the fallback."""
    letters = "".join(ch for ch in reference if ch.isalpha()).upper()
    if not letters:
        return position
    index = 0
    for ch in letters:
        index = index * 26 + (ord(ch) - ord("A") + 1)
    return index - 1


def _bounded(value: str) -> str:
    return value[:MAX_DATASET_HEADER_CHARS]


def _sheet_table(name: str, sheet: ET.Element, shared: list[str]) -> _SheetTable:
    """One worksheet as a bounded table; a cut is marked, never hidden."""
    data = sheet.find(f"{{{_X}}}sheetData")
    rows: list[list[str]] = []
    col_count = 0
    truncated = False
    columns_truncated = False
    for row in (data.findall(f"{{{_X}}}row") if data is not None else []):
        # The cap counts data rows: a header row never eats into the bound,
        # so a full bound of rows is still recorded in full.
        if len(rows) > 0 and len(rows) - 1 >= MAX_DATASET_ROWS:
            truncated = True
            break
        cells: list[str] = []
        for position, cell in enumerate(row.findall(f"{{{_X}}}c")):
            index = _column_index(cell.get("r") or "", position)
            # Columns past the cap are outside the recorded schema; a cell
            # whose reference points backwards would corrupt the alignment
            # this table relies on, so it is skipped, not mis-placed — and
            # the cut is marked, like every other bound.
            if index >= MAX_DATASET_COLUMNS:
                columns_truncated = True
                continue
            if index < len(cells):
                continue
            while len(cells) < index:
                cells.append("")
            cells.append(_bounded(_cell_value(cell, shared)))
        col_count = max(col_count, len(cells))
        rows.append(cells)
    return _SheetTable(name=name, headers=rows[0] if rows else [], rows=rows[1:],
                       col_count=col_count, truncated=truncated,
                       columns_truncated=columns_truncated)


def _xlsx_tables(raw: bytes) -> tuple[list[_SheetTable], bool]:
    """Every sheet of a workbook, in workbook order; a corrupt archive raises.

    Returns the parsed tables plus the honest ``more`` marker for workbooks
    that hold more sheets than the recorded cap — a cut is marked, never hidden.
    """
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        workbook = _xml_part(archive, "xl/workbook.xml")
        relationships = _xml_part(archive, "xl/_rels/workbook.xml.rels")
        shared: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            strings = _xml_part(archive, "xl/sharedStrings.xml")
            shared = ["".join(node.text or "" for node in item.iter(f"{{{_X}}}t"))
                      for item in strings.findall(f"{{{_X}}}si")]
        targets = {element.get("Id"): element.get("Target") or "" for element in relationships}
        sheets = []
        for sheet in workbook.iter(f"{{{_X}}}sheet"):
            name = sheet.get("name") or ""
            target = targets.get(sheet.get(f"{{{_XR}}}id") or "", "").lstrip("/")
            if target and not target.startswith("xl/"):
                target = f"xl/{target}"
            sheets.append((name, target))
        # An unresolved target is a corrupt workbook, not a missing sheet.
        parts = [(name, _xml_part(archive, target)) for name, target in sheets]
    more = len(parts) > MAX_DATASET_SHEETS
    return [_sheet_table(name, sheet, shared) for name, sheet in parts[:MAX_DATASET_SHEETS]], more


def _csv_table(raw: bytes, name: str) -> _SheetTable:
    """One CSV as a bounded single-sheet table; a structure error raises."""
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("decode") from exc
    if "\x00" in text:
        raise ValueError("binary")
    rows: list[list[str]] = []
    truncated = False
    columns_truncated = False
    try:
        for row in csv.reader(io.StringIO(text)):
            # The cap counts data rows: a header row never eats into the
            # bound, so a full bound of rows is still recorded in full.
            if len(rows) > 0 and len(rows) - 1 >= MAX_DATASET_ROWS:
                truncated = True
                break
            if len(row) > MAX_DATASET_COLUMNS:
                columns_truncated = True
            rows.append([_bounded(cell) for cell in row[:MAX_DATASET_COLUMNS]])
    except csv.Error as exc:
        raise ValueError("csv") from exc
    # Ragged rows normalize to the widest row so every column lines up under
    # its header; the width is tracked once, never re-scanned per row.
    col_count = max((len(row) for row in rows), default=0)
    for row in rows:
        row.extend([""] * (col_count - len(row)))
    return _SheetTable(name=name, headers=rows[0] if rows else [], rows=rows[1:],
                       col_count=col_count, truncated=truncated,
                       columns_truncated=columns_truncated)


def _cell_kind(text: str) -> str | None:
    """One non-empty cell's inferred kind, or None when unclassifiable."""
    lowered = text.strip().lower()
    if lowered in _BOOLEAN:
        return "boolean"
    if _NUMBER.match(text) and not _LEADING_ZERO.match(text):
        return "number"
    if _DATETIME.match(text):
        try:
            datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
        return "datetime"
    return None


def _column_types(rows: list[list[str]], col_count: int) -> list[str]:
    """One type per column: a single unambiguous kind wins, everything else
    honestly stays string (including all-empty columns)."""
    types = []
    for col in range(col_count):
        kinds = set()
        for row in rows:
            text = row[col].strip() if col < len(row) else ""
            if not text:
                continue
            kind = _cell_kind(text)
            kinds.add(kind if kind is not None else "string")
        types.append(kinds.pop() if len(kinds) == 1 else "string")
    return types


def _sheet_fingerprint(table: _SheetTable) -> str:
    """A content fingerprint over the sheet's own cells (headers and data
    rows, joined). Only the digest is kept — never the cells — and the sheet
    name is deliberately excluded: renaming an identical table must not
    change its content identity."""
    digest = hashlib.sha256()
    for row in [table.headers, *table.rows]:
        digest.update(b"\x1e")
        for cell in row:
            digest.update(cell.encode("utf-8"))
            digest.update(b"\x1f")
    return digest.hexdigest()


def _sheet_view(table: _SheetTable) -> dict[str, Any]:
    """One sheet's recorded facts: identity, schema, counts, honest markers."""
    headers = [table.headers[col] if col < len(table.headers) else ""
               for col in range(table.col_count)]
    types = _column_types(table.rows, table.col_count)
    summary = "、".join(f"{header or '·'}:{kind}" for header, kind in zip(headers, types))
    return {
        "name": table.name[:MAX_DATASET_HEADER_CHARS],
        "fingerprint": _sheet_fingerprint(table),
        "headers": headers,
        "columnTypes": types,
        "schema": summary[:MAX_DATASET_SCHEMA_CHARS],
        "rowCount": len(table.rows),
        "colCount": table.col_count,
        "truncated": table.truncated,
        "columnsTruncated": table.columns_truncated,
    }


def _failure(reason: str, format_name: str = "") -> dict[str, Any]:
    """A fixed-reason failure; the recognized format is kept when the suffix
    named one (a failed row that never parsed says so honestly with '')."""
    return {"status": "failed", "parser": "", "parser_version": "", "format": format_name,
            "reason": reason}


def parse_dataset(raw: bytes, filename: str) -> dict[str, Any]:
    """Parse one table file's bytes and return its honest sheet facts.

    The returned sheets carry headers, inferred column types, row/column
    counts and a per-sheet content fingerprint. Row data itself never
    persists: the caller records these facts and the file fingerprint only.
    """
    suffix = Path(filename).suffix.lower()
    format_name = "xlsx" if suffix == ".xlsx" else "csv" if suffix == ".csv" else ""
    if len(raw) > MAX_DATASET_FILE_BYTES:
        return _failure(DATASETS_FILE_TOO_LARGE, format_name)
    if suffix not in SUPPORTED_DATASET_EXTENSIONS:
        return _failure(DATASETS_FORMAT_UNSUPPORTED)
    try:
        if suffix == ".xlsx":
            tables, more_sheets = _xlsx_tables(raw)
            parser = XLSX_DATASET_PARSER
        else:
            tables = [_csv_table(raw, Path(filename).stem[:MAX_DATASET_HEADER_CHARS] or filename)]
            more_sheets = False
            parser = CSV_DATASET_PARSER
    except (_PartTooLarge, zipfile.BadZipFile, KeyError, OSError, ET.ParseError, ValueError):
        return _failure(DATASETS_PARSE_FAILED, format_name)
    sheets = [_sheet_view(table) for table in tables]
    return {
        "status": "parsed",
        "parser": parser,
        "parser_version": STDLIB_PARSER_VERSION,
        "format": format_name,
        "sheets": sheets,
        "rowCount": sum(sheet["rowCount"] for sheet in sheets),
        "truncated": any(sheet["truncated"] for sheet in sheets) or more_sheets,
    }


class DatasetRegistry:
    """Device-local display facts for one identity's imported table datasets (#102).

    A ready row keeps the content fingerprint so a later import of identical
    bytes answers an explicit duplicate instead of writing a second row, and
    a failed row keeps its real fixed reason — the display must never
    impersonate a ready dataset. Rows keep the original file's local path so
    the display can point at the 原件 that stays on this machine, and never
    keep row data: sheets carry schema and counts only.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self._error = ""
        self._lock = threading.RLock()
        try:
            with self._db() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS datasets (
                    id TEXT PRIMARY KEY, binding TEXT NOT NULL,
                    source_path TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL DEFAULT '',
                    format TEXT NOT NULL DEFAULT '', file_sha256 TEXT NOT NULL DEFAULT '',
                    sheets TEXT NOT NULL DEFAULT '[]', row_count INTEGER NOT NULL DEFAULT 0,
                    project_id TEXT NOT NULL DEFAULT '', device_id TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL, error_code TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
                # Issue 101: the optional knowledge revision binding — 一套版本
                # 规矩 (决策票 62) unifies the five families on Revision. An
                # import may name the doc-library revision it accompanies;
                # older databases gain the columns with empty defaults.
                for column in ("kb_id TEXT NOT NULL DEFAULT ''",
                               "revision_id TEXT NOT NULL DEFAULT ''",
                               "revision_no INTEGER NOT NULL DEFAULT 0"):
                    try:
                        db.execute(f"ALTER TABLE datasets ADD COLUMN {column}")
                    except sqlite3.OperationalError:
                        pass
        except (sqlite3.Error, OSError):
            self._error = DATASETS_STORAGE_UNAVAILABLE

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
                self._error = DATASETS_STORAGE_UNAVAILABLE
                raise DatasetError(DATASETS_STORAGE_UNAVAILABLE) from exc

    @staticmethod
    def _encoded(binding) -> str:
        return json.dumps(binding, sort_keys=True)

    @staticmethod
    def _identity(binding, status: str, file_sha256: str, error_code: str) -> str:
        """The row's content identity: identical bytes for one identity answer
        one row (dedup), while a different failure reason keeps its own row."""
        return hashlib.sha256(json.dumps([DatasetRegistry._encoded(binding), status,
                                          file_sha256, error_code]).encode()).hexdigest()

    def record(self, binding, row: dict[str, Any]) -> tuple[str, bool]:
        """Record one dataset row; the first fact per identity wins.

        Returns (row id, inserted). A second import of identical ready
        content inserts nothing and answers the existing identity instead.
        """
        status = "ready" if row.get("status") == "ready" else "failed"
        file_sha256 = str(row.get("file_sha256", ""))[:64]
        fields = {
            "source_path": str(row.get("source_path", ""))[:4096],
            "filename": str(row.get("filename", ""))[:256],
            "format": str(row.get("format", ""))[:16],
            "file_sha256": file_sha256,
            "sheets": json.dumps((row.get("sheets") or [])[:MAX_DATASET_SHEETS]),
            "row_count": int(row.get("row_count", 0) or 0),
            "project_id": str(row.get("project_id", ""))[:128],
            "device_id": str(row.get("device_id", ""))[:128],
            # Issue 101: the optional knowledge revision binding — display
            # facts only; the desktop dispatch has already fail-closed the
            # binding against this identity's own registered revisions.
            "kb_id": str(row.get("kb_id", ""))[:128],
            "revision_id": str(row.get("revision_id", ""))[:128],
            "revision_no": int(row.get("revision_no", 0) or 0),
            "status": status,
            "error_code": str(row.get("error_code", ""))[:128],
        }
        identity = self._identity(binding, status, file_sha256, fields["error_code"])

        def write(db):
            cursor = db.execute(
                "INSERT OR IGNORE INTO datasets (id, binding, source_path, filename, format,"
                " file_sha256, sheets, row_count, project_id, device_id,"
                " kb_id, revision_id, revision_no, status, error_code)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (identity, self._encoded(binding), fields["source_path"], fields["filename"],
                 fields["format"], fields["file_sha256"], fields["sheets"], fields["row_count"],
                 fields["project_id"], fields["device_id"], fields["kb_id"],
                 fields["revision_id"], fields["revision_no"], fields["status"],
                 fields["error_code"]))
            return cursor.rowcount == 1

        return identity, self._execute(write)

    @staticmethod
    def _sheet_projection(sheet: Any) -> dict[str, Any] | None:
        """The bounded wire facts of one sheet: identity, summary, counts."""
        if not isinstance(sheet, dict):
            return None
        return {
            "name": str(sheet.get("name", ""))[:MAX_DATASET_HEADER_CHARS],
            "fingerprint": str(sheet.get("fingerprint", ""))[:64],
            "schema": str(sheet.get("schema", ""))[:MAX_DATASET_SCHEMA_CHARS],
            "rowCount": sheet.get("rowCount") if isinstance(sheet.get("rowCount"), int) else 0,
            "colCount": sheet.get("colCount") if isinstance(sheet.get("colCount"), int) else 0,
            "truncated": sheet.get("truncated") is True,
            "columnsTruncated": sheet.get("columnsTruncated") is True,
        }

    @classmethod
    def _view(cls, row) -> dict[str, Any]:
        try:
            sheets = json.loads(row["sheets"])
        except (ValueError, TypeError):
            sheets = []
        # Issue 101: the revision binding surfaces exactly when it was
        # recorded; an empty or partial binding reads as unbound, never as a
        # made-up identity.
        kb_id = row["kb_id"] if "kb_id" in row.keys() else ""
        revision_id = row["revision_id"] if "revision_id" in row.keys() else ""
        revision_no = row["revision_no"] if "revision_no" in row.keys() else 0
        return {
            "id": row["id"], "filename": row["filename"], "sourcePath": row["source_path"],
            "format": row["format"], "fileSha256": row["file_sha256"],
            "sheets": [projected for projected in
                       (cls._sheet_projection(sheet) for sheet in sheets[:MAX_DATASET_SHEETS])
                       if projected is not None],
            "rowCount": row["row_count"], "projectId": row["project_id"],
            "deviceId": row["device_id"], "status": row["status"],
            "revision": {"kbId": kb_id, "revisionId": revision_id, "revisionNo": revision_no}
                if kb_id and revision_id else None,
            "errorCode": row["error_code"], "createdAt": row["created_at"],
        }

    def view(self, binding, limit: int = 20) -> list[dict[str, Any]]:
        """Rows for the current identity only; another account never inherits them."""

        def read(db):
            rows = db.execute("SELECT * FROM datasets WHERE binding=? ORDER BY rowid DESC LIMIT ?",
                              (self._encoded(binding), int(limit))).fetchall()
            return [self._view(row) for row in rows]

        return self._execute(read)

    def find_ready(self, binding, file_sha256: str) -> dict[str, Any] | None:
        """The ready row for one content fingerprint, if this identity has one."""

        def read(db):
            row = db.execute("SELECT id FROM datasets WHERE binding=? AND file_sha256=? AND status='ready'"
                             " ORDER BY rowid DESC LIMIT 1",
                             (self._encoded(binding), str(file_sha256)[:64])).fetchone()
            return {"id": row["id"]} if row is not None else None

        return self._execute(read)

    def delete(self, binding, dataset_id: str) -> bool:
        """Remove one registry row; the original file is never touched."""

        def write(db):
            cursor = db.execute("DELETE FROM datasets WHERE id=? AND binding=?",
                                (str(dataset_id)[:128], self._encoded(binding)))
            return cursor.rowcount == 1

        return self._execute(write)


def _read_source(source_path: str) -> bytes:
    """Read one picked file once, bounded; unreadable names fail fixed."""
    try:
        picked = Path(source_path)
        if picked.stat().st_size > MAX_DATASET_FILE_BYTES:
            raise DatasetError(DATASETS_FILE_TOO_LARGE)
        return picked.read_bytes()
    except DatasetError:
        raise
    except (OSError, ValueError) as exc:
        raise DatasetError(DATASETS_FILE_UNREADABLE) from exc


def _reply(registry: DatasetRegistry, owner, **flags: Any) -> dict[str, Any]:
    """Every reply carries the identity's own post-action list, bounded."""
    return {"datasets": registry.view(owner)[:20], **flags}


def datasets_manage(command: dict, *, registry: DatasetRegistry, owner) -> dict[str, Any]:
    """The one device-local datasets dispatch (#102): import or delete.

    The workspace scope fence is applied by the caller — desktop.py owns the
    workspace object — and the registry is the family's only state. An import
    reads the picked file once (原件留本机: nothing is moved, copied or
    removed), records one row, and answers honestly: a new ready row,
    an explicit duplicate for identical content, or a failed row with its
    real fixed reason. A delete removes the registry row only.
    """
    if not isinstance(command, dict):
        raise DatasetError(DATASETS_COMMAND_INVALID)
    action = command.get("action")
    if action == "import":
        if owner is None:
            raise DatasetError(DATASETS_UNAUTHENTICATED)
        source_path = command.get("path")
        project_id = command.get("projectId", "")
        # Issue 101: the optional knowledge revision binding rides the same
        # command; absent fields mean unbound, a malformed one is refused
        # instead of silently recorded as an identity it never had.
        kb_id = command.get("kbId", "")
        revision_id = command.get("revisionId", "")
        revision_no = command.get("revisionNo", 0)
        if (not isinstance(source_path, str) or not source_path or len(source_path) > 32768
                or not isinstance(project_id, str) or len(project_id) > 128
                or not isinstance(kb_id, str) or len(kb_id) > 128
                or not isinstance(revision_id, str) or len(revision_id) > 128
                or type(revision_no) is not int or not 0 <= revision_no <= 1000000
                or (bool(kb_id) != bool(revision_id))):
            raise DatasetError(DATASETS_COMMAND_INVALID)
        raw = _read_source(source_path)
        digest = hashlib.sha256(raw).hexdigest()
        existing = registry.find_ready(owner, digest)
        if existing is not None:
            return _reply(registry, owner, duplicate=True, duplicateOf=existing["id"])
        filename = Path(source_path).name[:256]
        parsed = parse_dataset(raw, filename)
        if parsed["status"] != "parsed":
            identity, _ = registry.record(owner, {
                "status": "failed", "source_path": source_path, "filename": filename,
                # The recognized format is an honest fact even on failure
                # ('' only when the suffix named no supported format).
                "format": parsed.get("format", ""), "file_sha256": digest,
                "error_code": parsed["reason"],
                "project_id": project_id, "device_id": owner.get("device_id", ""),
                "kb_id": kb_id, "revision_id": revision_id, "revision_no": revision_no})
            return _reply(registry, owner, failed=True, datasetId=identity,
                          errorCode=parsed["reason"])
        identity, inserted = registry.record(owner, {
            "status": "ready", "source_path": source_path, "filename": filename,
            "format": parsed["format"], "file_sha256": digest, "sheets": parsed["sheets"],
            "row_count": parsed["rowCount"], "project_id": project_id,
            "device_id": owner.get("device_id", ""),
            "kb_id": kb_id, "revision_id": revision_id, "revision_no": revision_no})
        if not inserted:
            # A concurrent identical import won the race: answer duplicate.
            return _reply(registry, owner, duplicate=True, duplicateOf=identity)
        return _reply(registry, owner, imported=True, datasetId=identity)
    if action == "delete":
        if owner is None:
            raise DatasetError(DATASETS_UNAUTHENTICATED)
        dataset_id = command.get("datasetId")
        if not isinstance(dataset_id, str) or not dataset_id or len(dataset_id) > 128:
            raise DatasetError(DATASETS_COMMAND_INVALID)
        if not registry.delete(owner, dataset_id):
            raise DatasetError(DATASETS_NOT_FOUND)
        return _reply(registry, owner, deleted=True)
    raise DatasetError(DATASETS_COMMAND_INVALID)
