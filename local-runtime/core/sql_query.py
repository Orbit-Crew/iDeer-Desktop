"""Read-only SQL over this identity's own imported table datasets (#103).

The engine answers one bounded SELECT against an in-memory SQLite copy of
one registered dataset's sheets — the same parsing engine that recorded the
import facts re-reads the 原件, so a query and its dataset row can never
disagree about the file. The original file is only ever read, and nothing
about the copy persists: the database is built per query and discarded.

Read-only is enforced by the engine, not by trusting the caller: the
connection carries an authorizer that denies every action except the read
path of a plain SELECT (statement reads, internal sort indexes, recursive
and window evaluation), a fixed function allowlist replaces the default
function gate, and the one-statement discipline of ``execute`` refuses
multi-statement text. Write statements, ATTACH, PRAGMA and unlisted
functions therefore all answer the same honest fixed category — refused,
with nothing done.

The reply is bounded on every axis before it exists: rows, columns, cell
characters, total characters, and a deterministic VM-instruction budget
that interrupts a runaway query at a reproducible point (the honest stand-in
for a wall-clock timeout, which a pure engine does not read). Values the
wire cannot carry honestly — blobs and non-finite numbers — answer null and
raise the cut marker instead of pretending they survived.
"""
from __future__ import annotations

import math
import re
import sqlite3
from typing import Any

from .datasets import (
    DATASETS_FILE_TOO_LARGE,
    DatasetError,
    DatasetRegistry,
    MAX_DATASET_COLUMNS,
    MAX_DATASET_HEADER_CHARS,
    MAX_DATASET_SHEETS,
    _SheetTable,
    _column_types,
    _read_source,
    parse_dataset_tables,
)

# The query text itself is bounded before it is parsed at all.
MAX_SQL_QUERY_CHARS = 10_000
# The reply's four honest bounds; a cut is always marked, never hidden.
MAX_SQL_RESULT_ROWS = 200
MAX_SQL_RESULT_COLUMNS = 64
MAX_SQL_CELL_CHARS = 512
MAX_SQL_RESULT_CHARS = 256_000
# The in-memory copy refuses datasets past this total cell count: a bound
# the load phase can check before a single cell is copied.
MAX_SQL_TABLE_CELLS = 2_000_000
# The deterministic stand-in for a timeout: VM instructions of query work,
# checked every 10_000 steps. Pure — no wall clock is ever read.
MAX_SQL_VM_STEPS = 5_000_000
_MAX_SQL_COLUMN_CHARS = 128

SQL_QUERY_COMMAND_INVALID = "SQL_QUERY_COMMAND_INVALID"
SQL_QUERY_UNAUTHENTICATED = "SQL_QUERY_UNAUTHENTICATED"
SQL_QUERY_NOT_FOUND = "SQL_QUERY_NOT_FOUND"
SQL_QUERY_FILE_TOO_LARGE = "SQL_QUERY_FILE_TOO_LARGE"
SQL_QUERY_FILE_UNREADABLE = "SQL_QUERY_FILE_UNREADABLE"
SQL_QUERY_PARSE_FAILED = "SQL_QUERY_PARSE_FAILED"
SQL_QUERY_DATASET_TOO_LARGE = "SQL_QUERY_DATASET_TOO_LARGE"
SQL_QUERY_IDENTITY_CHANGED = "SQL_QUERY_IDENTITY_CHANGED"
SQL_QUERY_FORBIDDEN = "SQL_QUERY_FORBIDDEN"
SQL_QUERY_INTERRUPTED = "SQL_QUERY_INTERRUPTED"
SQL_QUERY_EXECUTION_FAILED = "SQL_QUERY_EXECUTION_FAILED"
SQL_QUERY_FAILED = "SQL_QUERY_FAILED"

_DATASET_ID = re.compile(r"^[0-9a-f]{64}$")

# Pure built-ins only: the list is the whole answer to "which functions may
# a query call". random/randomblob (non-deterministic), load_extension and
# every sqlite_* introspection helper are outside it on purpose.
_SQL_FUNCTIONS = frozenset({
    # scalar text and numbers
    "abs", "ceil", "ceiling", "char", "coalesce", "exp", "floor", "format",
    "hex", "iif", "ifnull", "instr", "length", "likely", "lower", "ltrim",
    "mod", "nullif", "octet_length", "pi", "pow", "power", "printf", "quote",
    "replace", "round", "rtrim", "sign", "substr", "substring", "trim",
    "typeof", "unicode", "unlikely", "upper",
    # math extensions of the bundled sqlite
    "acos", "asin", "atan", "atan2", "cos", "degrees", "ln", "log", "log10",
    "log2", "radians", "sin", "sqrt", "tan",
    # aggregates
    "avg", "count", "group_concat", "max", "min", "sum", "total",
    # date and time (ISO-8601 text world only)
    "current_date", "current_time", "current_timestamp", "date", "datetime",
    "julianday", "strftime", "time", "unixepoch",
    # json1, pure text in and out
    "json", "json_array", "json_extract", "json_object", "json_quote",
    "json_type", "json_valid",
})

# The one authorizer allowlist: the read path of a plain SELECT. Sort
# indexes and recursive/window evaluation are the engine's own internals for
# reading; every write, schema, attach, pragma and load action is absent.
_SELECT_ACTIONS = frozenset(
    code for code in (
        getattr(sqlite3, "SQLITE_SELECT", None),
        getattr(sqlite3, "SQLITE_READ", None),
        getattr(sqlite3, "SQLITE_FUNCTION", None),
        getattr(sqlite3, "SQLITE_CREATE_TEMP_INDEX", None),
        getattr(sqlite3, "SQLITE_RECURSIVE", None),
        getattr(sqlite3, "SQLITE_WINDOW", None),
    ) if code is not None)


class SqlQueryError(RuntimeError):
    """A fixed-category sql-query failure; safe to surface as an error code."""


def category_for(error: BaseException) -> str:
    """Map device-side failures onto the fixed sql-query categories."""
    if isinstance(error, SqlQueryError):
        return str(error)
    return SQL_QUERY_FAILED


def _authorize(action: int, arg1: Any, arg2: Any, db_name: Any, trigger: Any) -> int:
    """Deny by default; the read path and the pure function list are the
    only allowances. DENY makes SQLite raise ``not authorized``, which the
    executor maps onto the fixed refused category. For a function call the
    name arrives in ``arg2`` (arg1 stays None)."""
    if action in _SELECT_ACTIONS:
        if action == getattr(sqlite3, "SQLITE_FUNCTION", -1):
            return (sqlite3.SQLITE_OK if str(arg2 or "").lower() in _SQL_FUNCTIONS
                    else sqlite3.SQLITE_DENY)
        return sqlite3.SQLITE_OK
    return sqlite3.SQLITE_DENY


def _registered_columns(headers: list[str], col_count: int) -> list[str]:
    """The exact column names the copy registers: the sheet's own headers,
    with empty names answered deterministically and duplicates deduplicated
    the same way every time (SQLite identifiers are case-insensitive)."""
    names: list[str] = []
    used: set[str] = set()
    for col in range(col_count):
        base = (headers[col] if col < len(headers) else "").strip()[:_MAX_SQL_COLUMN_CHARS]
        if not base:
            base = f"c{col + 1}"
        name = base
        suffix = 2
        while name.lower() in used:
            name = f"{base}_{suffix}"
            suffix += 1
        used.add(name.lower())
        names.append(name)
    return names


def _typed_value(text: str, kind: str) -> str | int | float | None:
    """One dataset cell as the copy stores it. Number columns hold numbers
    (so aggregates and comparisons work), boolean columns hold 1/0, and a
    value that will not convert keeps its recorded text — the parser's
    inference, not a new guess. An empty cell is SQL NULL: it means no
    value, and aggregates should skip it."""
    if text == "":
        return None  # type: ignore[return-value]
    if kind == "number":
        try:
            value: int | float = int(text)
            if not -(2 ** 63) < value < 2 ** 63:
                value = float(text)
        except ValueError:
            try:
                value = float(text)
            except ValueError:
                return text
        return value if math.isfinite(value) else text
    if kind == "boolean":
        return 1 if text.strip().lower() == "true" else 0
    return text


def _load_copy(tables: list[_SheetTable]) -> sqlite3.Connection:
    """Build the per-query in-memory copy: one table per sheet, named
    ``sheet1..sheetN`` in import order. Loading runs before the authorizer
    is installed — these inserts are the engine's own copy work, never part
    of the user's statement."""
    db = sqlite3.connect(":memory:")
    try:
        registered: list[tuple[str, list[str]]] = []
        for index, table in enumerate(tables):
            name = f"sheet{index + 1}"
            columns = _registered_columns(table.headers, table.col_count)
            kinds = _column_types(table.rows, table.col_count)
            decls = ", ".join(
                f'"{column}" {"NUMERIC" if kind == "number" else "INTEGER" if kind == "boolean" else "TEXT"}'
                for column, kind in zip(columns, kinds))
            db.execute(f'CREATE TABLE "{name}" ({decls})')
            if table.rows:
                rows = [[_typed_value(row[col] if col < len(row) else "", kind)
                         for col, kind in enumerate(kinds)]
                        for row in table.rows]
                placeholders = ", ".join("?" for _ in kinds)
                db.executemany(f'INSERT INTO "{name}" VALUES ({placeholders})', rows)
            registered.append((name, columns))
        db.commit()
    except sqlite3.Error:
        db.close()
        raise
    return db


def _wire_cell(value: Any, budget: int) -> tuple[str | int | float | None, bool, int]:
    """One result cell as the wire may carry it, with the honest cut marker
    and the characters it spent from the total budget. Numbers ride as
    numbers — the recorded types, not a re-guess; blobs and non-finite
    numbers answer null and raise the marker instead of pretending they
    survived."""
    if value is None:
        return None, False, 0
    if isinstance(value, bytes):
        return None, True, 0
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return None, True, 0
        text = str(value)
        if len(text) > budget:
            return None, True, 0
        return value, False, len(text)
    text = str(value)
    cut = len(text) > MAX_SQL_CELL_CHARS
    text = text[:MAX_SQL_CELL_CHARS]
    if len(text) > budget:
        text = text[:budget]
        cut = True
    return text, cut, len(text)


def _execute_read(db: sqlite3.Connection, sql: str) -> dict[str, Any]:
    """One read statement against the fenced copy, bounded on every axis."""
    if not sql.lstrip().lower().startswith(("select", "with")):
        raise SqlQueryError(SQL_QUERY_FORBIDDEN)
    steps = {"used": 0}

    def budget() -> int:
        steps["used"] += 10_000
        return 1 if steps["used"] > MAX_SQL_VM_STEPS else 0

    db.set_authorizer(_authorize)
    db.set_progress_handler(budget, 10_000)
    try:
        cursor = db.execute(sql)
        description = cursor.description or []
        columns_truncated = len(description) > MAX_SQL_RESULT_COLUMNS
        columns = [str(col[0] or "")[:_MAX_SQL_COLUMN_CHARS]
                   for col in description[:MAX_SQL_RESULT_COLUMNS]]
        rows: list[list[Any]] = []
        truncated = False
        cells_truncated = False
        remaining = MAX_SQL_RESULT_CHARS
        while True:
            batch = cursor.fetchmany(64)
            if not batch:
                break
            for row in batch:
                if len(rows) >= MAX_SQL_RESULT_ROWS or remaining <= 0:
                    truncated = True
                    break
                values: list[Any] = []
                spent_total = 0
                for value in row[:MAX_SQL_RESULT_COLUMNS]:
                    converted, cut, spent = _wire_cell(value, remaining)
                    cells_truncated = cells_truncated or cut
                    spent_total += spent
                    values.append(converted)
                remaining -= spent_total
                rows.append(values)
        return {
            "columns": columns,
            "rows": rows,
            "rowCount": len(rows),
            "truncated": truncated,
            "columnsTruncated": columns_truncated,
            "cellsTruncated": cells_truncated,
        }
    except sqlite3.ProgrammingError as exc:
        # execute() refuses multi-statement text before anything runs.
        raise SqlQueryError(SQL_QUERY_FORBIDDEN) from exc
    except sqlite3.DatabaseError as exc:
        # A prepare-time denial surfaces as plain DatabaseError, a runtime
        # one as OperationalError — both carry ``not authorized``.
        message = str(exc)
        if "not authorized" in message:
            raise SqlQueryError(SQL_QUERY_FORBIDDEN) from exc
        if "interrupted" in message:
            raise SqlQueryError(SQL_QUERY_INTERRUPTED) from exc
        raise SqlQueryError(SQL_QUERY_EXECUTION_FAILED) from exc


def sql_query(command: Any, *, registry: DatasetRegistry, owner: Any) -> dict[str, Any]:
    """The one device-local sql-query dispatch (#103): a bounded read-only
    SELECT over one of this identity's own ready datasets.

    The workspace scope fence is applied by the caller — desktop.py owns
    the workspace object — and the copy lives exactly as long as this call.
    The reply carries the registered table/column names (so the pane shows
    what the query may reference), the bounded rows and the honest cut
    markers.
    """
    if not isinstance(command, dict):
        raise SqlQueryError(SQL_QUERY_COMMAND_INVALID)
    if command.get("action") != "query":
        raise SqlQueryError(SQL_QUERY_COMMAND_INVALID)
    if owner is None:
        raise SqlQueryError(SQL_QUERY_UNAUTHENTICATED)
    dataset_id = command.get("datasetId")
    sql = command.get("sql")
    if (not isinstance(dataset_id, str) or not _DATASET_ID.match(dataset_id)
            or not isinstance(sql, str) or not sql.strip()
            or len(sql) > MAX_SQL_QUERY_CHARS):
        raise SqlQueryError(SQL_QUERY_COMMAND_INVALID)
    try:
        row = registry.find_query_target(owner, dataset_id)
    except DatasetError as exc:
        # The registry's own storage category stays the honest answer; the
        # query never ran, so no sql-specific code pretends otherwise.
        raise SqlQueryError(str(exc)) from exc
    if row is None:
        raise SqlQueryError(SQL_QUERY_NOT_FOUND)
    try:
        raw = _read_source(row["source_path"])
    except DatasetError as exc:
        raise SqlQueryError(SQL_QUERY_FILE_TOO_LARGE if str(exc) == DATASETS_FILE_TOO_LARGE
                            else SQL_QUERY_FILE_UNREADABLE) from exc
    try:
        tables = parse_dataset_tables(raw, row["filename"])
    except DatasetError as exc:
        raise SqlQueryError(SQL_QUERY_PARSE_FAILED) from exc
    tables = tables[:MAX_DATASET_SHEETS]
    if sum(table.col_count * len(table.rows) for table in tables) > MAX_SQL_TABLE_CELLS:
        raise SqlQueryError(SQL_QUERY_DATASET_TOO_LARGE)
    registered = [(f"sheet{index + 1}",
                   table.name[:MAX_DATASET_HEADER_CHARS],
                   _registered_columns(table.headers, table.col_count))
                  for index, table in enumerate(tables[:MAX_DATASET_SHEETS])]
    db = _load_copy(tables)
    try:
        answer = _execute_read(db, sql)
    finally:
        db.close()
    return {
        "tables": [{"table": name, "name": sheet_name, "columns": columns[:MAX_DATASET_COLUMNS]}
                   for name, sheet_name, columns in registered],
        **answer,
    }
