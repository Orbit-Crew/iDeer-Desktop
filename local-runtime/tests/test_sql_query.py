"""Read-only SQL over this identity's imported table datasets (#103).

Every test drives the real query engine with genuinely imported datasets in
a temporary profile: SELECT reads over the typed in-memory copy answer real
rows, while every write statement, every multi-statement input and every
function outside the engine's fixed allowlist is refused with the one honest
fixed category, and a missing, deleted or mutated source file answers its
own fixed reason instead of a wrong result.
Row data lives only inside the per-query in-memory database: the registry
still keeps identity, schema and counts only. The reply bounds — rows,
columns, cells, total characters, the deterministic VM budget and the
wall-clock deadline — are pinned.
"""
from __future__ import annotations

import base64
import json
import queue
import threading
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

from core import desktop
from core.datasets import DatasetRegistry, datasets_manage
from core.protocol import public_key_text
from core.settings import RuntimeSettings
from core.sql_query import (
    MAX_SQL_CELL_CHARS,
    MAX_SQL_QUERY_CHARS,
    MAX_SQL_RESULT_COLUMNS,
    MAX_SQL_RESULT_ROWS,
    SQL_QUERY_COMMAND_INVALID,
    SQL_QUERY_DATASET_TOO_LARGE,
    SQL_QUERY_EXECUTION_FAILED,
    SQL_QUERY_FILE_UNREADABLE,
    SQL_QUERY_FORBIDDEN,
    SQL_QUERY_IDENTITY_CHANGED,
    SQL_QUERY_INTERRUPTED,
    SQL_QUERY_NOT_FOUND,
    SQL_QUERY_PARSE_FAILED,
    SQL_QUERY_UNAUTHENTICATED,
    sql_query,
)

OWNER = {'server_origin': 'http://127.0.0.1:108', 'user_id': 'A', 'device_id': 'D1',
         'device_public_key': 'k1', 'broker_public_key': 'k2'}
OTHER = dict(OWNER, user_id='B', device_id='D2')


def make_registry(tmp_path: Path) -> DatasetRegistry:
    profile = Path(tmp_path) / 'profile'
    profile.mkdir(parents=True, exist_ok=True)
    return DatasetRegistry(profile / 'datasets.db')


def picked_file(tmp_path: Path, name: str, content: bytes) -> str:
    path = Path(tmp_path) / name
    path.write_bytes(content)
    return str(path)


def imported_dataset(tmp_path: Path, registry: DatasetRegistry, name: str, content: bytes) -> str:
    """Import one real dataset through the real dispatch and answer its id."""
    result = datasets_manage({'action': 'import', 'path': picked_file(tmp_path, name, content),
                              'projectId': ''}, registry=registry, owner=OWNER)
    assert result['imported'] is True
    return result['datasetId']


def query(registry: DatasetRegistry, dataset_id: str, sql: str):
    return sql_query({'action': 'query', 'datasetId': dataset_id, 'sql': sql},
                     registry=registry, owner=OWNER)


# --- Slice 1: read-only SELECT over the typed in-memory copy ---------------

def test_select_over_imported_csv_answers_typed_rows(tmp_path):
    registry = make_registry(tmp_path)
    content = ('编号,名称,生效,加入日期\n'
               '1,widget,true,2024-01-15\n'
               '2,gadget,false,2024-02-20\n'
               '3,thing,true,2024-03-25\n').encode('utf-8')
    dataset_id = imported_dataset(tmp_path, registry, 'table.csv', content)
    result = query(registry, dataset_id, 'SELECT 编号, 名称 FROM sheet1 WHERE 生效 = 1 ORDER BY 编号')
    assert result['tables'] == [{'table': 'sheet1', 'name': 'table',
                                 'columns': ['编号', '名称', '生效', '加入日期']}]
    assert result['columns'] == ['编号', '名称']
    assert result['rows'] == [[1, 'widget'], [3, 'thing']]
    assert result['rowCount'] == 2
    assert result['truncated'] is False
    assert result['columnsTruncated'] is False
    assert result['cellsTruncated'] is False


def test_aggregates_read_numeric_columns_as_numbers(tmp_path):
    registry = make_registry(tmp_path)
    content = 'a,b\n1,x\n2,y\n3.5,z\n'.encode('utf-8')
    dataset_id = imported_dataset(tmp_path, registry, 'nums.csv', content)
    result = query(registry, dataset_id, 'SELECT round(sum(a), 1), count(*) FROM sheet1')
    assert result['rows'] == [[6.5, 3]]


def test_empty_cells_answer_null_not_empty_string(tmp_path):
    registry = make_registry(tmp_path)
    dataset_id = imported_dataset(tmp_path, registry, 'gaps.csv', b'a,b\n1,\n2,y\n')
    result = query(registry, dataset_id, 'SELECT b FROM sheet1 ORDER BY a')
    assert result['rows'] == [[None], ['y']]
    assert query(registry, dataset_id, 'SELECT count(b) FROM sheet1')['rows'] == [[1]]


def _two_sheet_xlsx() -> bytes:
    """A real two-sheet workbook, built with the stdlib zip/xml discipline."""
    import io
    import zipfile
    X_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'

    def worksheet(cell_text: str, cell_value: str) -> str:
        return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                f'<worksheet xmlns="{X_NS}"><sheetData>'
                f'<row r="1"><c r="A1" t="inlineStr"><is><t>{cell_text}</t></is></c></row>'
                f'<row r="2"><c r="A2"><v>{cell_value}</v></c></row>'
                '</sheetData></worksheet>')

    sheets = [('销售', worksheet('v', 5)), ('对照', worksheet('k', 7))]
    sheet_tags = ''.join(
        f'<sheet name="{name}" sheetId="{index + 1}" r:id="rId{index + 1}" />'
        for index, (name, _xml) in enumerate(sheets))
    workbook = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                f'<workbook xmlns="{X_NS}" xmlns:r="http://schemas.openxmlformats.org/'
                f'officeDocument/2006/relationships"><sheets>{sheet_tags}</sheets></workbook>')
    relationships = ''.join(
        f'<Relationship Id="rId{index + 1}" Type="http://schemas.openxmlformats.org/'
        f'officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{index + 1}.xml" />'
        for index in range(len(sheets)))
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'{relationships}</Relationships>')
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('xl/workbook.xml', workbook)
        archive.writestr('xl/_rels/workbook.xml.rels', rels)
        for index, (_name, xml) in enumerate(sheets):
            archive.writestr(f'xl/worksheets/sheet{index + 1}.xml', xml)
    return buffer.getvalue()


def test_multi_sheet_tables_are_registered_in_import_order(tmp_path):
    registry = make_registry(tmp_path)
    dataset_id = imported_dataset(tmp_path, registry, 'book.xlsx', _two_sheet_xlsx())
    result = query(registry, dataset_id, 'SELECT * FROM sheet2')
    assert result['tables'][0]['table'] == 'sheet1'
    assert result['tables'][0]['name'] == '销售'
    assert result['tables'][1]['table'] == 'sheet2'
    assert result['tables'][1]['name'] == '对照'
    assert result['columns'] == ['k']
    assert result['rows'] == [[7]]
    first = query(registry, dataset_id, 'SELECT * FROM sheet1')
    assert first['rows'] == [[5]]


def test_duplicate_and_empty_headers_get_deterministic_names(tmp_path):
    registry = make_registry(tmp_path)
    dataset_id = imported_dataset(tmp_path, registry, 'dup.csv', b'a,,a\n1,x,2\n')
    result = query(registry, dataset_id, 'SELECT * FROM sheet1')
    assert result['tables'][0]['columns'] == ['a', 'c2', 'a_2']
    assert result['columns'] == ['a', 'c2', 'a_2']
    assert result['rows'] == [[1, 'x', 2]]


def test_same_query_answers_the_same_result(tmp_path):
    registry = make_registry(tmp_path)
    dataset_id = imported_dataset(tmp_path, registry, 't.csv', b'a\n1\n2\n')
    first = query(registry, dataset_id, 'SELECT * FROM sheet1 ORDER BY a')
    second = query(registry, dataset_id, 'SELECT * FROM sheet1 ORDER BY a')
    assert first == second


# --- Slice 2: the read-only fence ------------------------------------------

@pytest.mark.parametrize('sql', [
    'INSERT INTO sheet1 VALUES (1)',
    'UPDATE sheet1 SET a = 1',
    'DELETE FROM sheet1',
    'DROP TABLE sheet1',
    'CREATE TABLE t (x)',
    'ALTER TABLE sheet1 RENAME TO t',
    "ATTACH DATABASE ':memory:' AS m",
    'PRAGMA journal_mode',
    'BEGIN',
    'REPLACE INTO sheet1 VALUES (1)',
    'WITH x AS (SELECT 1) INSERT INTO sheet1 SELECT * FROM x',
    'VACUUM',
])
def test_write_statements_are_refused_with_the_fixed_category(tmp_path, sql):
    registry = make_registry(tmp_path)
    dataset_id = imported_dataset(tmp_path, registry, 'fence.csv', b'a\n1\n')
    with pytest.raises(Exception) as caught:
        query(registry, dataset_id, sql)
    assert str(caught.value) == SQL_QUERY_FORBIDDEN
    # The in-memory copy is per-query: the registry rows are untouched anyway,
    # and the original file was never opened for write by anything here.


def test_multi_statement_input_is_refused(tmp_path):
    registry = make_registry(tmp_path)
    dataset_id = imported_dataset(tmp_path, registry, 'multi.csv', b'a\n1\n')
    with pytest.raises(Exception) as caught:
        query(registry, dataset_id, 'SELECT 1; SELECT 2')
    assert str(caught.value) == SQL_QUERY_FORBIDDEN


@pytest.mark.parametrize('sql', [
    'SELECT random()',
    'SELECT randomblob(8)',
    "SELECT load_extension('x')",
    'SELECT sqlite_version()',
    'SELECT sqlite_source_id()',
])
def test_functions_outside_the_allowlist_are_refused(tmp_path, sql):
    registry = make_registry(tmp_path)
    dataset_id = imported_dataset(tmp_path, registry, 'fn.csv', b'a\n1\n')
    with pytest.raises(Exception) as caught:
        query(registry, dataset_id, sql)
    assert str(caught.value) == SQL_QUERY_FORBIDDEN


def test_statements_that_are_not_reads_are_refused_up_front(tmp_path):
    registry = make_registry(tmp_path)
    dataset_id = imported_dataset(tmp_path, registry, 'shape.csv', b'a\n1\n')
    with pytest.raises(Exception) as caught:
        query(registry, dataset_id, '  EXPLAIN SELECT * FROM sheet1')
    assert str(caught.value) == SQL_QUERY_FORBIDDEN
    # A WITH-prefixed read stays a read and answers rows.
    result = query(registry, dataset_id, 'WITH t AS (SELECT a FROM sheet1) SELECT * FROM t')
    assert result['rows'] == [[1]]
    # SQLite honours leading comments; a comment before a read is still a
    # read, so the prefix gate skips them instead of mislabeling it.
    commented = query(registry, dataset_id, '-- 最新数据\n\nSELECT * FROM sheet1')
    assert commented['rows'] == [[1]]


def test_syntax_and_unknown_columns_answer_execution_failed(tmp_path):
    registry = make_registry(tmp_path)
    dataset_id = imported_dataset(tmp_path, registry, 'bad.csv', b'a\n1\n')
    with pytest.raises(Exception) as caught:
        query(registry, dataset_id, 'SELECT nope FROM sheet1')
    assert str(caught.value) == SQL_QUERY_EXECUTION_FAILED
    with pytest.raises(Exception) as caught:
        query(registry, dataset_id, 'SELECT FROM WHERE')
    assert str(caught.value) == SQL_QUERY_EXECUTION_FAILED


# --- Slice 3: the bounded reply --------------------------------------------

def test_row_limit_truncates_honestly(tmp_path):
    registry = make_registry(tmp_path)
    lines = ['a\n'] + [f'{index}\n' for index in range(1000)]
    dataset_id = imported_dataset(tmp_path, registry, 'many.csv', ''.join(lines).encode('utf-8'))
    result = query(registry, dataset_id, 'SELECT * FROM sheet1')
    assert result['rowCount'] == MAX_SQL_RESULT_ROWS
    assert result['truncated'] is True
    assert len(result['rows']) == MAX_SQL_RESULT_ROWS


def test_row_limit_marks_one_row_beyond_the_bound(tmp_path):
    registry = make_registry(tmp_path)
    lines = ['a\n'] + [f'{index}\n' for index in range(MAX_SQL_RESULT_ROWS)]
    dataset_id = imported_dataset(tmp_path, registry, 'exact.csv', ''.join(lines).encode('utf-8'))
    result = query(registry, dataset_id, 'SELECT * FROM sheet1')
    assert result['rowCount'] == MAX_SQL_RESULT_ROWS
    assert result['truncated'] is False


def test_column_limit_truncates_honestly(tmp_path):
    registry = make_registry(tmp_path)
    header = ','.join(f'c{index}' for index in range(MAX_SQL_RESULT_COLUMNS + 5))
    row = ','.join(str(index) for index in range(MAX_SQL_RESULT_COLUMNS + 5))
    dataset_id = imported_dataset(tmp_path, registry, 'wide.csv', f'{header}\n{row}\n'.encode('utf-8'))
    result = query(registry, dataset_id, 'SELECT * FROM sheet1')
    assert result['columnsTruncated'] is True
    assert len(result['columns']) == MAX_SQL_RESULT_COLUMNS
    assert len(result['rows'][0]) == MAX_SQL_RESULT_COLUMNS


def test_oversized_cells_are_cut_and_marked(tmp_path):
    registry = make_registry(tmp_path)
    # The parser stores each cell bounded at 128 chars; the query engine's
    # own cell bound fires when a computed value grows past 512.
    dataset_id = imported_dataset(tmp_path, registry, 'long.csv',
                                  ('a\n' + 'x' * 128 + '\n').encode('utf-8'))
    result = query(registry, dataset_id, 'SELECT a || a || a || a || a FROM sheet1')
    assert result['cellsTruncated'] is True
    cell = result['rows'][0][0]
    assert isinstance(cell, str) and len(cell) == MAX_SQL_CELL_CHARS


def test_total_character_budget_truncates(tmp_path):
    registry = make_registry(tmp_path)
    # The column cap carries only the first 64 columns, so one full row
    # spends 64 x 128 chars; 40 such rows pass the total budget and the
    # honest cut fires well below the row limit.
    header = ','.join(f'c{index}' for index in range(128))
    body = '\n'.join(','.join(['x' * 128] * 128) for _ in range(40))
    dataset_id = imported_dataset(tmp_path, registry, 'budget.csv',
                                  f'{header}\n{body}\n'.encode('utf-8'))
    result = query(registry, dataset_id, 'SELECT * FROM sheet1')
    assert result['truncated'] is True
    assert result['rowCount'] < 40


def test_blob_and_nonfinite_values_answer_null_with_the_marker(tmp_path):
    registry = make_registry(tmp_path)
    dataset_id = imported_dataset(tmp_path, registry, 'weird.csv', b'a\n1\n')
    result = query(registry, dataset_id, "SELECT x'4142', 9.0e999 FROM sheet1")
    assert result['rows'] == [[None, None]]
    assert result['cellsTruncated'] is True


def test_vm_budget_interrupts_a_runaway_query(tmp_path):
    registry = make_registry(tmp_path)
    dataset_id = imported_dataset(tmp_path, registry, 'run.csv', b'a\n1\n')
    with pytest.raises(Exception) as caught:
        query(registry, dataset_id,
              'WITH RECURSIVE t(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM t)'
              ' SELECT count(*) FROM t')
    assert str(caught.value) == SQL_QUERY_INTERRUPTED


def test_wall_clock_deadline_interrupts_where_the_vm_budget_cannot(tmp_path, monkeypatch):
    from core import sql_query as sql_module
    # The wall-clock deadline shares the progress handler with the VM budget:
    # an already-past deadline trips the very first check, so a query whose
    # cost hides inside slow steps still stops at the next check and answers
    # the same honest interrupted category instead of holding the device loop.
    monkeypatch.setattr(sql_module, 'MAX_SQL_WALL_CLOCK_MS', 0)
    registry = make_registry(tmp_path)
    body = '\n'.join(str(row) for row in range(128))
    dataset_id = imported_dataset(tmp_path, registry, 'rows.csv',
                                  f'n\n{body}\n'.encode('utf-8'))
    with pytest.raises(Exception) as caught:
        # count(*) with no WHERE would take SQLite's scan-the-table
        # shortcut and never reach the first progress check; the row-wise
        # aggregate forces the join the deadline must interrupt.
        query(registry, dataset_id, 'SELECT count(a.n + b.n) FROM sheet1 a, sheet1 b')
    assert str(caught.value) == SQL_QUERY_INTERRUPTED


def test_dataset_over_the_load_bound_answers_the_fixed_category(tmp_path, monkeypatch):
    from core import sql_query as sql_module
    monkeypatch.setattr(sql_module, 'MAX_SQL_TABLE_CELLS', 2)
    registry = make_registry(tmp_path)
    dataset_id = imported_dataset(tmp_path, registry, 'big.csv', b'a,b\n1,2\n3,4\n')
    with pytest.raises(Exception) as caught:
        query(registry, dataset_id, 'SELECT * FROM sheet1')
    assert str(caught.value) == SQL_QUERY_DATASET_TOO_LARGE


# --- Slice 4: honest failures and the identity fence -----------------------

def test_unknown_dataset_answers_not_found(tmp_path):
    registry = make_registry(tmp_path)
    with pytest.raises(Exception) as caught:
        query(registry, 'f' * 64, 'SELECT 1')
    assert str(caught.value) == SQL_QUERY_NOT_FOUND


def test_failed_rows_are_not_queryable(tmp_path):
    registry = make_registry(tmp_path)
    result = datasets_manage({'action': 'import', 'path': picked_file(tmp_path, 'broken.xlsx', b'PK\x03\x04truncated'),
                              'projectId': ''}, registry=registry, owner=OWNER)
    assert result['failed'] is True
    with pytest.raises(Exception) as caught:
        query(registry, result['datasetId'], 'SELECT * FROM sheet1')
    assert str(caught.value) == SQL_QUERY_NOT_FOUND


def test_rows_are_scoped_to_one_identity(tmp_path):
    registry = make_registry(tmp_path)
    dataset_id = imported_dataset(tmp_path, registry, 'scoped.csv', b'a\n1\n')
    with pytest.raises(Exception) as caught:
        sql_query({'action': 'query', 'datasetId': dataset_id, 'sql': 'SELECT * FROM sheet1'},
                  registry=registry, owner=OTHER)
    assert str(caught.value) == SQL_QUERY_NOT_FOUND


def test_unauthenticated_queries_are_refused(tmp_path):
    with pytest.raises(Exception) as caught:
        sql_query({'action': 'query', 'datasetId': 'f' * 64, 'sql': 'SELECT 1'},
                  registry=None, owner=None)  # type: ignore[arg-type]
    assert str(caught.value) == SQL_QUERY_UNAUTHENTICATED


@pytest.mark.parametrize('command', [
    None,
    {},
    {'action': 'list', 'datasetId': 'f' * 64, 'sql': 'SELECT 1'},
    {'action': 'query', 'datasetId': 'nothex', 'sql': 'SELECT 1'},
    {'action': 'query', 'datasetId': 'F' * 64, 'sql': 'SELECT 1'},
    {'action': 'query', 'datasetId': 'f' * 64},
    {'action': 'query', 'datasetId': 'f' * 64, 'sql': ''},
    {'action': 'query', 'datasetId': 'f' * 64, 'sql': '   '},
    {'action': 'query', 'datasetId': 'f' * 64, 'sql': 'x' * (MAX_SQL_QUERY_CHARS + 1)},
    {'action': 'query', 'datasetId': 7, 'sql': 'SELECT 1'},
])
def test_malformed_commands_answer_the_fixed_category(tmp_path, command):
    with pytest.raises(Exception) as caught:
        sql_query(command, registry=make_registry(tmp_path), owner=OWNER)
    assert str(caught.value) == SQL_QUERY_COMMAND_INVALID


def test_deleted_or_moved_source_answers_unreadable(tmp_path):
    registry = make_registry(tmp_path)
    dataset_id = imported_dataset(tmp_path, registry, 'gone.csv', b'a\n1\n')
    rows = registry.view(OWNER)
    Path(rows[0]['sourcePath']).unlink()
    with pytest.raises(Exception) as caught:
        query(registry, dataset_id, 'SELECT * FROM sheet1')
    assert str(caught.value) == SQL_QUERY_FILE_UNREADABLE


def test_mutated_source_that_no_longer_parses_answers_parse_failed(tmp_path):
    registry = make_registry(tmp_path)
    dataset_id = imported_dataset(tmp_path, registry, 'mutated.xlsx', _tiny_xlsx())
    rows = registry.view(OWNER)
    Path(rows[0]['sourcePath']).write_bytes(b'PK\x03\x04truncated-garbage')
    with pytest.raises(Exception) as caught:
        query(registry, dataset_id, 'SELECT * FROM sheet1')
    assert str(caught.value) == SQL_QUERY_PARSE_FAILED


def _tiny_xlsx() -> bytes:
    """A real one-sheet workbook, built with the stdlib zip/xml discipline."""
    import io
    import zipfile
    X_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    worksheet = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                 f'<worksheet xmlns="{X_NS}"><sheetData>'
                 '<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row>'
                 '<row r="2"><c r="A2"><v>1</v></c></row>'
                 '</sheetData></worksheet>')
    workbook = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                f'<workbook xmlns="{X_NS}" xmlns:r="http://schemas.openxmlformats.org/'
                f'officeDocument/2006/relationships"><sheets>'
                '<sheet name="表一" sheetId="1" r:id="rId1" />'
                '</sheets></workbook>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/'
            '2006/relationships/worksheet" Target="worksheets/sheet1.xml" /></Relationships>')
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('xl/workbook.xml', workbook)
        archive.writestr('xl/_rels/workbook.xml.rels', rels)
        archive.writestr('xl/worksheets/sheet1.xml', worksheet)
    return buffer.getvalue()


# --- Slice 5: the wire-level desktop loop ----------------------------------

class SqlHarness:
    """Drive desktop.main() in a thread with scripted commands and replies.

    Mirrors the #102 datasets harness; both families' frames settle the
    one-command-one-reply wait.
    """

    def __init__(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        self.tmp_path = tmp_path
        config = tmp_path / 'profile' / 'settings.json'
        key = Ed25519PrivateKey.generate()
        settings = RuntimeSettings(
            server_url='http://127.0.0.1:108', user_id='account-102', device_id='device-102',
            session_token_ref='fixture-session', device_key_ref='fixture-key',
            device_public_key=public_key_text(key), server_public_key=public_key_text(key))
        settings.save(config)
        self.config = config
        self.login_state = {'value': 'authenticated'}
        self.frames: list[dict] = []
        self._reply = threading.Event()
        self._lines: queue.Queue = queue.Queue()
        self._lock = threading.Lock()
        self._exit: dict[str, int] = {}
        self.scope = ''

        class Client:
            connected = True
            active = 0
            file_service = __import__('types').SimpleNamespace()

            def begin_install_drain(self):
                pass

            def abort_install_drain(self):
                pass

            def active_task_count(self):
                return self.active

        class Controller:
            settings = __import__('types').SimpleNamespace(session_token='synthetic')

            def __init__(self):
                self.client = Client()

            def start(self):
                pass

            def status(self):
                return __import__('types').SimpleNamespace(connection='connected')

            def stop(self):
                pass

        self.controller = Controller()

        class Input:
            def __iter__(self):
                return self

            def __next__(self):
                line = self.lines.get()
                if line is None:
                    raise StopIteration
                return line

        Input.lines = self._lines

        class Output:
            def write(self, value):
                self.sink._write(value)
                return len(value)

            def flush(self):
                pass

        Output.sink = self

        secure = __import__('types').SimpleNamespace(get=lambda reference: base64.b64encode(
            key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())).decode())
        login = __import__('types').SimpleNamespace(
            secure=secure, restore=lambda: None, server_origin=lambda: 'http://127.0.0.1:108',
            status=lambda: {'state': self.login_state['value']})
        gate = __import__('types').SimpleNamespace(bind=lambda: None, snapshot=lambda: {})

        monkeypatch.setattr(desktop, 'own_process_tree', lambda: None)
        monkeypatch.setattr(desktop, 'create_default_secret_store', lambda: secure)
        monkeypatch.setattr(desktop, 'BrowserLogin', lambda *args: login)
        monkeypatch.setattr(desktop, 'CompatibilityGate', lambda *args, **kwargs: gate)
        monkeypatch.setattr(desktop, 'load_controller', lambda *args, **kwargs: self.controller)
        monkeypatch.setattr(desktop.sys, 'argv', ['desktop', '--config', str(config)])
        monkeypatch.setattr(desktop.sys, 'stdin', Input())
        monkeypatch.setattr(desktop.sys, 'stdout', Output())

    def select_workspace(self, path: Path) -> None:
        from core.file_service import WorkspaceSelection
        selection = WorkspaceSelection(self.config)
        selection.select(str(path), confirmed=True)
        self.scope = selection.scope()

    def _write(self, value: str) -> None:
        pending = getattr(self, '_pending', '')
        pending += value
        while '\n' in pending:
            line, pending = pending.split('\n', 1)
            if not line:
                continue
            frame = json.loads(line)
            with self._lock:
                self.frames.append(frame)
            if frame.get('type') in ('datasets', 'sql'):
                self._reply.set()
        self._pending = pending

    def start(self) -> None:
        self._pending = ''
        self._thread = threading.Thread(
            target=lambda: self._exit.update(code=desktop.main()), daemon=True)
        self._thread.start()

    def command(self, payload: dict, *, expect_reply: bool = True) -> dict | None:
        self._lines.put(json.dumps(payload) + '\n')
        if not expect_reply:
            return None
        # Poll for THIS command's own frame: another family's reply may set
        # the event early, so a bare event wait can wake on the wrong frame.
        import time
        deadline = time.time() + 15
        while time.time() < deadline:
            with self._lock:
                for frame in reversed(self.frames):
                    if (frame.get('type') == payload.get('type')
                            and frame.get('id') == payload.get('id')):
                        return frame
            time.sleep(0.02)
        kinds = [frame.get('type') for frame in self.frames]
        raise RuntimeError(
            f'no reply for {payload.get("id")}; exit={self._exit} frames={kinds[-12:]}')

    def finish(self) -> int:
        self._lines.put('{"type":"shutdown"}\n')
        self._thread.join(30)
        assert not self._thread.is_alive(), 'desktop.main did not stop'
        return self._exit.get('code', 1)


def test_wire_gate_drops_malformed_sql_commands(tmp_path, monkeypatch) -> None:
    work = Path(tmp_path) / 'work'
    work.mkdir()
    harness = SqlHarness(tmp_path, monkeypatch)
    harness.select_workspace(work)
    harness.start()
    try:
        # The gate drops these shapes silently: no reply is ever queued.
        for payload in (
                {'type': 'sql', 'id': 'a', 'action': 'list', 'datasetId': 'f' * 64,
                 'sql': 'SELECT 1', 'scope': harness.scope},
                {'type': 'sql', 'id': 'c', 'action': 'query', 'datasetId': 'f' * 64,
                 'sql': '', 'scope': harness.scope},
                {'type': 'sql', 'id': 'd', 'action': 'query', 'datasetId': 'f' * 64,
                 'sql': 'SELECT 1', 'scope': harness.scope, 'extra': True}):
            harness.command(payload, expect_reply=False)
        # A shape-valid command with a non-hex identity passes the gate and
        # reaches the engine, which answers its own fixed category. Waiting
        # for this reply keeps the one-slot queue protocol: the next command
        # is only sent after this one has drained.
        gated = harness.command({'type': 'sql', 'id': 'b', 'action': 'query',
                                 'datasetId': 'nothex', 'sql': 'SELECT 1',
                                 'scope': harness.scope})
        assert gated['error'] == SQL_QUERY_COMMAND_INVALID
        # The reader loop survived every malformed line and still answers a
        # well-formed one — the gate drops, it never kills the child.
        reply = harness.command({'type': 'sql', 'id': 'ok', 'action': 'query',
                                 'datasetId': 'f' * 64, 'sql': 'SELECT 1',
                                 'scope': harness.scope})
        assert reply['error'] == SQL_QUERY_NOT_FOUND
    finally:
        harness.finish()


def test_query_round_trip_over_a_real_import(tmp_path, monkeypatch) -> None:
    work = Path(tmp_path) / 'work'
    work.mkdir()
    (work / 'table.csv').write_text('city,amount\n京,120\n沪,80\n', encoding='utf-8')
    harness = SqlHarness(tmp_path, monkeypatch)
    harness.select_workspace(work)
    harness.start()
    try:
        imported = harness.command({'type': 'datasets', 'id': 'i1', 'action': 'import',
                                    'path': str(work / 'table.csv'), 'projectId': 'prj_1',
                                    'scope': harness.scope})
        assert imported['result']['imported'] is True
        dataset_id = imported['result']['datasetId']
        reply = harness.command({'type': 'sql', 'id': 'q1', 'action': 'query',
                                 'datasetId': dataset_id,
                                 'sql': 'SELECT city, sum(amount) FROM sheet1 GROUP BY city ORDER BY city',
                                 'scope': harness.scope})
        assert reply['error'] == ''
        result = reply['result']
        assert result['tables'][0]['name'] == 'table'
        assert result['columns'] == ['city', 'sum(amount)']
        assert result['rows'] == [['京', 120], ['沪', 80]]
    finally:
        harness.finish()


def test_query_is_fenced_by_scope(tmp_path, monkeypatch) -> None:
    work = Path(tmp_path) / 'work'
    work.mkdir()
    (work / 'fenced.csv').write_text('a\n1\n', encoding='utf-8')
    harness = SqlHarness(tmp_path, monkeypatch)
    harness.select_workspace(work)
    harness.start()
    try:
        imported = harness.command({'type': 'datasets', 'id': 'i1', 'action': 'import',
                                    'path': str(work / 'fenced.csv'), 'projectId': '',
                                    'scope': harness.scope})
        dataset_id = imported['result']['datasetId']
        reply = harness.command({'type': 'sql', 'id': 'q1', 'action': 'query',
                                 'datasetId': dataset_id, 'sql': 'SELECT * FROM sheet1',
                                 'scope': 'another-scope'})
        assert reply['result'] is None
        assert reply['error'] == SQL_QUERY_IDENTITY_CHANGED
    finally:
        harness.finish()
