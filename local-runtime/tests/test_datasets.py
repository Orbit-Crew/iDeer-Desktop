"""Table dataset import: real device-side XLSX/CSV parsing and registry (#102).

Every test drives the real parsing and registry seam with genuine bytes built
in memory or a real picked file in a temporary directory. A multi-sheet
workbook records per-sheet headers, recognized column types and honest
counts; a CSV's columns infer number/boolean/datetime types with an honest
string fallback; a file the device cannot parse is recorded as failed with
its fixed reason — never impersonating a ready dataset — and identical
content re-imported answers an explicit duplicate instead of a second row.
Row data never persists: the registry keeps identity, schema and counts only.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import queue
import threading
import zipfile
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

from core import desktop
from core.datasets import (
    DATASETS_COMMAND_INVALID,
    DATASETS_FILE_TOO_LARGE,
    DATASETS_FORMAT_UNSUPPORTED,
    DATASETS_NOT_FOUND,
    DATASETS_PARSE_FAILED,
    DATASETS_STORAGE_UNAVAILABLE,
    DATASETS_UNAUTHENTICATED,
    MAX_DATASET_COLUMNS,
    MAX_DATASET_FILE_BYTES,
    MAX_DATASET_ROWS,
    MAX_DATASET_SHEETS,
    DatasetError,
    DatasetRegistry,
    datasets_manage,
    parse_dataset,
)
from core.file_service import WorkspaceSelection
from core.protocol import public_key_text
from core.settings import RuntimeSettings

X_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


def worksheet(rows: str) -> str:
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<worksheet xmlns="{X_NS}"><sheetData>{rows}</sheetData></worksheet>')


def cells(refs_values: list[tuple[str, str, str]]) -> str:
    """One row's cells: (reference, attribute, inner) triples."""
    return "".join(f'<c r="{ref}"{attr}>{inner}</c>' for ref, attr, inner in refs_values)


def row(number: int, refs_values: list[tuple[str, str, str]]) -> str:
    return f'<row r="{number}">{cells(refs_values)}</row>'


def build_workbook(sheets: list[tuple[str, str]], shared: list[str] | None = None) -> bytes:
    sheet_tags = "".join(
        f'<sheet name="{name}" sheetId="{index + 1}" r:id="rId{index + 1}" />'
        for index, (name, _xml) in enumerate(sheets))
    workbook = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                f'<workbook xmlns="{X_NS}" xmlns:r="http://schemas.openxmlformats.org/'
                f'officeDocument/2006/relationships"><sheets>{sheet_tags}</sheets></workbook>')
    relationships = "".join(
        f'<Relationship Id="rId{index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/'
        f'2006/relationships/worksheet" Target="worksheets/sheet{index + 1}.xml" />'
        for index in range(len(sheets)))
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'{relationships}</Relationships>')
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", rels)
        for index, (_name, xml) in enumerate(sheets):
            archive.writestr(f"xl/worksheets/sheet{index + 1}.xml", xml)
        if shared is not None:
            items = "".join(f"<si><t>{text}</t></si>" for text in shared)
            archive.writestr("xl/sharedStrings.xml",
                             f'<?xml version="1.0"?><sst xmlns="{X_NS}" count="{len(shared)}"'
                             f' uniqueCount="{len(shared)}">{items}</sst>')
    return buffer.getvalue()


def test_xlsx_multi_sheet_records_headers_types_and_counts():
    sheet_one = worksheet(
        row(1, [("A1", ' t="inlineStr"', "<is><t>编号</t></is>"),
                ("B1", ' t="inlineStr"', "<is><t>名称</t></is>"),
                ("C1", ' t="inlineStr"', "<is><t>生效</t></is>"),
                ("D1", ' t="inlineStr"', "<is><t>备注</t></is>")])
        + row(2, [("A2", "", "<v>1</v>"),
                  ("B2", ' t="s"', "<v>0</v>"),
                  ("C2", ' t="b"', "<v>1</v>"),
                  ("D2", ' t="inlineStr"', "<is><t>first</t></is>")])
        + row(3, [("A3", "", "<v>2.5</v>"),
                  ("B3", ' t="s"', "<v>0</v>"),
                  ("C3", ' t="b"', "<v>0</v>"),
                  ("D3", ' t="inlineStr"', "<is><t>second</t></is>")]))
    # The second sheet omits B2 in its data row: positions come from the cell
    # references, never from the cell order, so C2 still lands in column 3.
    sheet_two = worksheet(
        row(1, [("A1", ' t="inlineStr"', "<is><t>名</t></is>"),
                ("B1", ' t="inlineStr"', "<is><t>量</t></is>"),
                ("C1", ' t="inlineStr"', "<is><t>值</t></is>")])
        + row(2, [("A2", ' t="inlineStr"', "<is><t>x</t></is>"),
                  ("C2", "", "<v>9</v>")]))
    raw = build_workbook([("库存", sheet_one), ("对照", sheet_two)], shared=["widget"])
    result = parse_dataset(raw, "book.xlsx")
    assert result["status"] == "parsed"
    assert result["parser"] == "xlsx-ooxml"
    assert result["format"] == "xlsx"
    assert result["truncated"] is False
    assert result["rowCount"] == 3
    sheets = result["sheets"]
    assert [sheet["name"] for sheet in sheets] == ["库存", "对照"]
    first = sheets[0]
    assert first["headers"] == ["编号", "名称", "生效", "备注"]
    assert first["columnTypes"] == ["number", "string", "boolean", "string"]
    assert first["rowCount"] == 2
    assert first["colCount"] == 4
    assert first["truncated"] is False
    assert len(first["fingerprint"]) == 64
    second = sheets[1]
    assert second["headers"] == ["名", "量", "值"]
    assert second["columnTypes"] == ["string", "string", "number"]
    assert second["rowCount"] == 1
    assert second["colCount"] == 3


def test_csv_type_inference_and_string_fallback():
    raw = ("编号,名称,生效,加入日期,备注\n"
           "1,widget,true,2024-01-15,note\n"
           "2,gadget,false,2024-02-20T10:30:00,\n"
           "3,thing,TRUE,2024-03-25,42\n").encode("utf-8")
    result = parse_dataset(raw, "table.csv")
    assert result["status"] == "parsed"
    assert result["parser"] == "csv-stdlib"
    assert result["format"] == "csv"
    assert result["rowCount"] == 3
    assert len(result["sheets"]) == 1
    sheet = result["sheets"][0]
    assert sheet["name"] == "table"
    assert sheet["headers"] == ["编号", "名称", "生效", "加入日期", "备注"]
    # 备注 mixes text and a number: an honest fallback stays string.
    assert sheet["columnTypes"] == ["number", "string", "boolean", "datetime", "string"]
    assert sheet["rowCount"] == 3
    assert sheet["colCount"] == 5
    assert sheet["truncated"] is False


def test_csv_infers_dates_with_spaces_and_leading_zero_ids_stay_string():
    raw = ("id,day,code\n"
           "007,2024-01-15 10:30:00,x\n"
           "042,2024-01-16 09:00:00,y\n").encode("utf-8")
    result = parse_dataset(raw, "codes.csv")
    sheet = result["sheets"][0]
    # Leading-zero codes are identifiers, not numbers; a space-separated
    # timestamp is still a datetime.
    assert sheet["columnTypes"] == ["string", "datetime", "string"]


def test_parse_fails_honestly_for_corrupt_and_unsupported_files():
    result = parse_dataset(b"PK\x03\x04truncated", "broken.xlsx")
    assert result["status"] == "failed"
    assert result["reason"] == DATASETS_PARSE_FAILED
    result = parse_dataset(b"old binary table", "legacy.xls")
    assert result["status"] == "failed"
    assert result["reason"] == DATASETS_FORMAT_UNSUPPORTED
    result = parse_dataset(b"\x00binary", "data.csv")
    assert result["status"] == "failed"
    assert result["reason"] == DATASETS_PARSE_FAILED


def test_oversize_file_refused_with_the_frozen_bound():
    raw = b"x" * (MAX_DATASET_FILE_BYTES + 1)
    result = parse_dataset(raw, "big.csv")
    assert result["status"] == "failed"
    assert result["reason"] == DATASETS_FILE_TOO_LARGE


def test_sheet_fingerprints_are_content_facts():
    one = parse_dataset(b"a,b\n1,2\n", "one.csv")
    two = parse_dataset(b"a,b\n1,3\n", "one.csv")
    same = parse_dataset(b"a,b\n1,2\n", "renamed.csv")
    assert one["sheets"][0]["fingerprint"] != two["sheets"][0]["fingerprint"]
    assert one["sheets"][0]["fingerprint"] == same["sheets"][0]["fingerprint"]


def test_beyond_bound_rows_are_marked_truncated_not_hidden():
    lines = ["n\n"] + [f"{index}\n" for index in range(1, MAX_DATASET_ROWS + 10)]
    result = parse_dataset("".join(lines).encode("utf-8"), "many.csv")
    assert result["status"] == "parsed"
    sheet = result["sheets"][0]
    assert sheet["truncated"] is True
    assert sheet["rowCount"] == MAX_DATASET_ROWS


def test_beyond_bound_sheets_are_marked_truncated_not_hidden():
    empty = worksheet("")
    raw = build_workbook([(f"S{index}", empty) for index in range(MAX_DATASET_SHEETS + 3)])
    result = parse_dataset(raw, "book.xlsx")
    assert result["status"] == "parsed"
    assert len(result["sheets"]) == MAX_DATASET_SHEETS
    assert result["truncated"] is True


def column_ref(index: int) -> str:
    """The spreadsheet reference letters for a 0-based column index (26→AA)."""
    letters = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


def test_beyond_cap_columns_are_marked_truncated_not_hidden():
    # A CSV row wider than the cap keeps the recorded 128 columns and marks
    # the cut instead of silently dropping the rest.
    header = ",".join(f"c{index}" for index in range(MAX_DATASET_COLUMNS + 2))
    values = ",".join(str(index) for index in range(MAX_DATASET_COLUMNS + 2))
    result = parse_dataset(f"{header}\n{values}\n".encode("utf-8"), "wide.csv")
    sheet = result["sheets"][0]
    assert sheet["colCount"] == MAX_DATASET_COLUMNS
    assert sheet["columnsTruncated"] is True
    assert sheet["truncated"] is False
    # A workbook cell whose reference lands past the cap marks the same cut.
    refs_values = [(f"{column_ref(index)}1", ' t="inlineStr"', f"<is><t>v{index}</t></is>")
                   for index in range(MAX_DATASET_COLUMNS + 2)]
    raw = build_workbook([("宽", worksheet(row(1, refs_values)))])
    result = parse_dataset(raw, "wide.xlsx")
    sheet = result["sheets"][0]
    assert sheet["colCount"] == MAX_DATASET_COLUMNS
    assert sheet["columnsTruncated"] is True
    assert sheet["headers"][-1] == f"v{MAX_DATASET_COLUMNS - 1}"


# --- Slice 2: the registry and the one device-local dispatch ---------------

OWNER = {'server_origin': 'http://127.0.0.1:108', 'user_id': 'A', 'device_id': 'D1',
         'device_public_key': 'k1', 'broker_public_key': 'k2'}
OTHER = dict(OWNER, user_id='B', device_id='D2')
PROJECT = 'prj_102'
# Issue 101: the optional knowledge revision binding's fixture identity.
KB = '33333333-3333-4333-8333-333333333333'
REVISION = '77777777-7777-4777-8777-777777777777'


def make_registry(tmp_path: Path) -> DatasetRegistry:
    # desktop.py mkdirs the profile before wiring registries; tests mirror it.
    profile = Path(tmp_path) / 'profile'
    profile.mkdir(parents=True, exist_ok=True)
    return DatasetRegistry(profile / 'datasets.db')


def picked_file(tmp_path: Path, name: str, content: bytes) -> str:
    path = Path(tmp_path) / name
    path.write_bytes(content)
    return str(path)


def view_rows(registry: DatasetRegistry) -> list[dict]:
    return registry.view(OWNER)


def test_import_registers_dataset_with_project_and_device_identity(tmp_path):
    registry = make_registry(tmp_path)
    source = picked_file(tmp_path, 'table.csv', b'a,b\n1,2\n')
    result = datasets_manage({'action': 'import', 'path': source, 'projectId': PROJECT},
                             registry=registry, owner=OWNER)
    assert result['imported'] is True
    rows = view_rows(registry)
    assert len(rows) == 1
    row = rows[0]
    assert row['status'] == 'ready'
    assert row['projectId'] == PROJECT
    assert row['deviceId'] == 'D1'
    assert row['filename'] == 'table.csv'
    assert row['sourcePath'] == source
    assert row['format'] == 'csv'
    assert row['fileSha256'] == hashlib.sha256(b'a,b\n1,2\n').hexdigest()
    assert row['sheets'][0]['schema'] == 'a:number、b:number'
    assert row['sheets'][0]['rowCount'] == 1
    assert result['datasetId'] == row['id']


def test_reimport_identical_content_answers_duplicate_without_second_row(tmp_path):
    registry = make_registry(tmp_path)
    content = b'a,b\n1,2\n'
    first = datasets_manage({'action': 'import', 'path': picked_file(tmp_path, 'one.csv', content),
                             'projectId': PROJECT}, registry=registry, owner=OWNER)
    # The same bytes under a different name are the same content fingerprint.
    second = datasets_manage({'action': 'import', 'path': picked_file(tmp_path, 'renamed.csv', content),
                              'projectId': ''}, registry=registry, owner=OWNER)
    assert first['imported'] is True
    assert 'imported' not in second
    assert second['duplicate'] is True
    assert second['duplicateOf'] == first['datasetId']
    assert len(view_rows(registry)) == 1


def test_failed_import_recorded_with_reason_and_a_fixed_file_imports(tmp_path):
    registry = make_registry(tmp_path)
    source = picked_file(tmp_path, 'book.xlsx', b'PK\x03\x04truncated')
    failed = datasets_manage({'action': 'import', 'path': source, 'projectId': PROJECT},
                             registry=registry, owner=OWNER)
    assert failed['failed'] is True
    assert failed['errorCode'] == DATASETS_PARSE_FAILED
    rows = view_rows(registry)
    assert len(rows) == 1
    assert rows[0]['status'] == 'failed'
    assert rows[0]['errorCode'] == DATASETS_PARSE_FAILED
    # The suffix named a supported format the device could not parse: the
    # failed row keeps that honest fact, and only an unrecognized suffix
    # answers format '' (the wire contract of a failed row, #102 review).
    assert rows[0]['format'] == 'xlsx'
    unsupported = datasets_manage({'action': 'import',
                                   'path': picked_file(tmp_path, 'legacy.xls', b'old binary'),
                                   'projectId': ''}, registry=registry, owner=OWNER)
    assert unsupported['failed'] is True
    assert view_rows(registry)[0]['format'] == ''
    assert unsupported['errorCode'] == DATASETS_FORMAT_UNSUPPORTED
    # Repairing the file and re-importing must not be blocked by the old row.
    sheet = worksheet(row(1, [("A1", ' t="inlineStr"', "<is><t>n</t></is>")])
                      + row(2, [("A2", "", "<v>7</v>")]))
    good = build_workbook([("表", sheet)])
    picked_file(tmp_path, 'book.xlsx', good)
    fixed = datasets_manage({'action': 'import', 'path': source, 'projectId': PROJECT},
                            registry=registry, owner=OWNER)
    assert fixed['imported'] is True
    rows = view_rows(registry)
    assert [row['status'] for row in rows] == ['ready', 'failed', 'failed']


def test_registry_rows_are_scoped_to_one_identity(tmp_path):
    registry = make_registry(tmp_path)
    source = picked_file(tmp_path, 'table.csv', b'a,b\n1,2\n')
    datasets_manage({'action': 'import', 'path': source, 'projectId': ''}, registry=registry, owner=OWNER)
    assert registry.view(OTHER) == []
    with pytest.raises(DatasetError) as exc:
        datasets_manage({'action': 'delete', 'datasetId': view_rows(registry)[0]['id']},
                        registry=registry, owner=OTHER)
    assert str(exc.value) == DATASETS_NOT_FOUND


def test_delete_removes_the_registry_row_only_and_the_original_stays(tmp_path):
    registry = make_registry(tmp_path)
    content = b'a,b\n1,2\n'
    source = picked_file(tmp_path, 'table.csv', content)
    imported = datasets_manage({'action': 'import', 'path': source, 'projectId': PROJECT},
                               registry=registry, owner=OWNER)
    deleted = datasets_manage({'action': 'delete', 'datasetId': imported['datasetId']},
                              registry=registry, owner=OWNER)
    assert deleted['deleted'] is True
    assert view_rows(registry) == []
    # 原件留本机: a delete is a registry row deletion, never a file deletion.
    assert Path(source).read_bytes() == content


def test_delete_unknown_dataset_answers_not_found(tmp_path):
    registry = make_registry(tmp_path)
    with pytest.raises(DatasetError) as exc:
        datasets_manage({'action': 'delete', 'datasetId': 'f' * 64}, registry=registry, owner=OWNER)
    assert str(exc.value) == DATASETS_NOT_FOUND


def test_unauthenticated_import_and_delete_are_refused(tmp_path):
    registry = make_registry(tmp_path)
    source = picked_file(tmp_path, 'table.csv', b'a,b\n1,2\n')
    with pytest.raises(DatasetError) as exc:
        datasets_manage({'action': 'import', 'path': source, 'projectId': ''}, registry=registry, owner=None)
    assert str(exc.value) == DATASETS_UNAUTHENTICATED
    with pytest.raises(DatasetError) as exc:
        datasets_manage({'action': 'delete', 'datasetId': 'f' * 64}, registry=registry, owner=None)
    assert str(exc.value) == DATASETS_UNAUTHENTICATED


def test_malformed_commands_answer_the_fixed_category(tmp_path):
    registry = make_registry(tmp_path)
    for command in ({}, {'action': 'list'}, {'action': 'import', 'path': '', 'projectId': ''},
                    {'action': 'import', 'path': 'x' * 32769, 'projectId': ''},
                    {'action': 'import', 'path': 'x', 'projectId': 'p' * 129},
                    {'action': 'delete', 'datasetId': ''}):
        with pytest.raises(DatasetError) as exc:
            datasets_manage(command, registry=registry, owner=OWNER)
        assert str(exc.value) == DATASETS_COMMAND_INVALID


def test_storage_failure_is_honest_never_silent(tmp_path):
    registry = DatasetRegistry(Path(tmp_path) / 'no-such-dir' / 'nested' / 'datasets.db')
    assert registry.error == DATASETS_STORAGE_UNAVAILABLE
    source = picked_file(tmp_path, 'table.csv', b'a,b\n1,2\n')
    with pytest.raises(DatasetError) as exc:
        datasets_manage({'action': 'import', 'path': source, 'projectId': ''}, registry=registry, owner=OWNER)
    assert str(exc.value) == DATASETS_STORAGE_UNAVAILABLE


def test_registered_rows_survive_a_registry_reopen(tmp_path):
    registry = make_registry(tmp_path)
    source = picked_file(tmp_path, 'table.csv', b'a,b\n1,2\n')
    imported = datasets_manage({'action': 'import', 'path': source, 'projectId': PROJECT},
                               registry=registry, owner=OWNER)
    reopened = make_registry(tmp_path)
    rows = reopened.view(OWNER)
    assert len(rows) == 1
    assert rows[0]['id'] == imported['datasetId']


# --- Slice 3: the desktop loop's wire gate, dispatch and status snapshot ----


class DatasetsHarness:
    """Drive desktop.main() in a thread with scripted commands and replies."""

    def __init__(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        self.tmp_path = tmp_path
        config = tmp_path / "profile" / "settings.json"
        key = Ed25519PrivateKey.generate()
        settings = RuntimeSettings(
            server_url="http://127.0.0.1:108", user_id="account-102", device_id="device-102",
            session_token_ref="fixture-session", device_key_ref="fixture-key",
            device_public_key=public_key_text(key), server_public_key=public_key_text(key))
        settings.save(config)
        self.config = config
        self.login_state = {"value": "authenticated"}
        self.frames: list[dict] = []
        self._reply = threading.Event()
        self._lines: queue.Queue = queue.Queue()
        self._lock = threading.Lock()
        self._exit: dict[str, int] = {}
        self.scope = ""

        class Client:
            connected = True
            active = 0
            file_service = __import__("types").SimpleNamespace()

            def begin_install_drain(self):
                pass

            def abort_install_drain(self):
                pass

            def active_task_count(self):
                return self.active

        class Controller:
            settings = __import__("types").SimpleNamespace(session_token="synthetic")

            def __init__(self):
                self.client = Client()

            def start(self):
                pass

            def status(self):
                return __import__("types").SimpleNamespace(connection="connected")

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

        secure = __import__("types").SimpleNamespace(get=lambda reference: base64.b64encode(
            key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())).decode())
        login = __import__("types").SimpleNamespace(
            secure=secure, restore=lambda: None, server_origin=lambda: "http://127.0.0.1:108",
            status=lambda: {"state": self.login_state["value"]})
        gate = __import__("types").SimpleNamespace(bind=lambda: None, snapshot=lambda: {})

        monkeypatch.setattr(desktop, "own_process_tree", lambda: None)
        monkeypatch.setattr(desktop, "create_default_secret_store", lambda: secure)
        monkeypatch.setattr(desktop, "BrowserLogin", lambda *args: login)
        monkeypatch.setattr(desktop, "CompatibilityGate", lambda *args, **kwargs: gate)
        monkeypatch.setattr(desktop, "load_controller", lambda *args, **kwargs: self.controller)
        monkeypatch.setattr(desktop.sys, "argv", ["desktop", "--config", str(config)])
        monkeypatch.setattr(desktop.sys, "stdin", Input())
        monkeypatch.setattr(desktop.sys, "stdout", Output())

    def select_workspace(self, path: Path) -> None:
        selection = WorkspaceSelection(self.config)
        selection.select(str(path), confirmed=True)
        self.scope = selection.scope()

    def _write(self, value: str) -> None:
        pending = getattr(self, "_pending", "")
        pending += value
        while "\n" in pending:
            line, pending = pending.split("\n", 1)
            if not line:
                continue
            frame = json.loads(line)
            with self._lock:
                self.frames.append(frame)
            if frame.get("type") == "datasets":
                self._reply.set()
        self._pending = pending

    def start(self) -> None:
        self._pending = ""
        self._thread = threading.Thread(
            target=lambda: self._exit.update(code=desktop.main()), daemon=True)
        self._thread.start()

    def command(self, payload: dict, *, expect_reply: bool = True) -> dict | None:
        self._reply.clear()
        self._lines.put(json.dumps(payload) + "\n")
        if not expect_reply:
            return None
        if not self._reply.wait(15):
            kinds = [frame.get("type") for frame in self.frames]
            raise RuntimeError(
                f"no datasets reply for {payload.get('id')}; exit={self._exit} frames={kinds[-12:]}")
        with self._lock:
            for frame in reversed(self.frames):
                if frame.get("type") == "datasets" and frame.get("id") == payload.get("id"):
                    return frame
        raise AssertionError("reply frame vanished")

    def finish(self) -> int:
        self._lines.put('{"type":"shutdown"}\n')
        self._thread.join(30)
        assert not self._thread.is_alive(), "desktop.main did not stop"
        return self._exit.get("code", 1)

    def wait_for_status(self, predicate, timeout: float = 5.0) -> dict:
        """The status tick runs on its own 0.5 s cadence; a registry write may
        land just after the newest frame, so tests poll for a matching one."""
        import time
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                frames = [frame for frame in self.frames
                          if frame.get("v") == 1 and "datasets" in frame]
            for frame in reversed(frames):
                if predicate(frame):
                    return frame
            time.sleep(0.05)
        raise AssertionError("no matching datasets status frame arrived")

    def status_frame_count(self) -> int:
        with self._lock:
            return sum(1 for frame in self.frames
                       if frame.get("v") == 1 and "datasets" in frame)

    def wait_for_more_status_frames(self, seen: int, timeout: float = 5.0) -> int:
        """Prove the status loop keeps ticking past a point — a dead child
        emits no further frames, so this is the liveness assertion."""
        import time
        deadline = time.time() + timeout
        while time.time() < deadline:
            count = self.status_frame_count()
            if count > seen:
                return count
            time.sleep(0.05)
        raise AssertionError(f"no status frame beyond #{seen}; the child likely died")


def make_datasets_harness(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> DatasetsHarness:
    # Built inside the test body, like the files/connectors harnesses: the
    # stdin/stdout patches must land during the call phase, after the runner
    # re-arms its own capture around sys.stdout.
    return DatasetsHarness(tmp_path, monkeypatch)


def seeded_work(tmp_path: Path) -> Path:
    work = Path(tmp_path) / "work"
    work.mkdir(parents=True, exist_ok=True)
    return work


def test_wire_gate_drops_malformed_datasets_commands(tmp_path, monkeypatch) -> None:
    harness = make_datasets_harness(tmp_path, monkeypatch)
    harness.select_workspace(seeded_work(tmp_path))
    harness.start()
    try:
        source = picked_file(tmp_path, 'table.csv', b'a,b\n1,2\n')
        malformed = [
            {"type": "datasets", "id": "d-1", "action": "import", "path": source, "scope": harness.scope},
            {"type": "datasets", "id": "d-2", "action": "import", "path": source, "projectId": "", "extra": True},
            {"type": "datasets", "id": "d-3", "action": "list", "scope": harness.scope},
            {"type": "datasets", "id": "d-4", "action": "delete", "scope": harness.scope},
            {"type": "datasets", "id": "d-5", "action": "import", "path": "", "projectId": "", "scope": harness.scope},
            {"type": "datasets", "id": "d-6", "action": "import", "path": source, "projectId": 7, "scope": harness.scope},
            {"type": "datasets", "id": "d-7", "action": "delete", "datasetId": "", "scope": harness.scope},
            {"type": "datasets", "id": "x" * 65, "action": "delete", "datasetId": "f" * 64, "scope": harness.scope},
            # Cross-action key sets: each must be dropped by the gate without
            # raising inside the reader thread (review finding, #102).
            {"type": "datasets", "id": "d-8", "action": "delete", "path": source,
             "projectId": "", "scope": harness.scope},
            {"type": "datasets", "id": "d-9", "action": "import", "datasetId": "f" * 64,
             "scope": harness.scope},
        ]
        for payload in malformed:
            harness.command(payload, expect_reply=False)
        replied = harness.command({"type": "datasets", "id": "ok-1", "action": "import",
                                   "path": source, "projectId": PROJECT, "scope": harness.scope})
        with harness._lock:
            datasets_frames = [frame for frame in harness.frames if frame.get("type") == "datasets"]
        assert [frame["id"] for frame in datasets_frames] == ["ok-1"]
        assert replied["error"] == ""
    finally:
        harness.finish()


def test_import_round_trip_records_status_and_dedups(tmp_path, monkeypatch) -> None:
    harness = make_datasets_harness(tmp_path, monkeypatch)
    harness.select_workspace(seeded_work(tmp_path))
    harness.start()
    try:
        content = b'a,b\n1,2\n'
        source = picked_file(tmp_path, 'table.csv', content)
        frame = harness.command({"type": "datasets", "id": "d-1", "action": "import",
                                 "path": source, "projectId": PROJECT, "scope": harness.scope})
        assert frame["error"] == ""
        assert frame["result"]["imported"] is True
        dataset_id = frame["result"]["datasetId"]
        status = harness.wait_for_status(lambda frame: len(frame["datasets"]) == 1)
        row = status["datasets"][0]
        assert row["projectId"] == PROJECT
        assert row["deviceId"] == "device-102"
        assert row["filename"] == "table.csv"
        assert row["status"] == "ready"
        assert status["datasetsStorageError"] == ""
        # The same content from a differently named file dedups on the wire.
        frame = harness.command({"type": "datasets", "id": "d-2", "action": "import",
                                 "path": picked_file(tmp_path, 'copy.csv', content),
                                 "projectId": "", "scope": harness.scope})
        assert frame["result"]["duplicate"] is True
        assert frame["result"]["duplicateOf"] == dataset_id
        harness.wait_for_status(lambda frame: len(frame["datasets"]) == 1)
    finally:
        harness.finish()


def test_import_with_revision_binding_records_the_display_fact(tmp_path, monkeypatch) -> None:
    # Issue 101: 一套版本规矩 — an import may name the doc-library revision
    # it accompanies; the binding is a display fact on the row and an absent
    # one stays unbound. The identity never changes with the binding, so the
    # same content still dedups to the row it already has.
    harness = make_datasets_harness(tmp_path, monkeypatch)
    harness.select_workspace(seeded_work(tmp_path))
    harness.start()
    try:
        content = b"a,b\n1,2\n"
        source = picked_file(tmp_path, 'table.csv', content)
        frame = harness.command({"type": "datasets", "id": "d-1", "action": "import",
                                 "path": source, "projectId": PROJECT, "kbId": KB,
                                 "revisionId": REVISION, "revisionNo": 3, "scope": harness.scope})
        assert frame["error"] == ""
        assert frame["result"]["imported"] is True
        dataset_id = frame["result"]["datasetId"]
        status = harness.wait_for_status(lambda frame: len(frame["datasets"]) == 1)
        row = status["datasets"][0]
        assert row["revision"] == {"kbId": KB, "revisionId": REVISION, "revisionNo": 3}
        # The plain import key set stays valid: unbound rows read as None.
        frame = harness.command({"type": "datasets", "id": "d-2", "action": "import",
                                 "path": picked_file(tmp_path, 'other.csv', b"x,y\n3,4\n"),
                                 "projectId": "", "scope": harness.scope})
        assert frame["error"] == ""
        status = harness.wait_for_status(lambda frame: len(frame["datasets"]) == 2)
        unbound = [row for row in status["datasets"] if row["id"] != dataset_id][0]
        assert unbound["revision"] is None
        # A malformed binding (kb without revision) is dropped by the wire
        # gate — never guessed into an identity the row never had.
        harness.command({"type": "datasets", "id": "d-3", "action": "import",
                         "path": picked_file(tmp_path, 'bad.csv', b"z\n1\n"),
                         "projectId": "", "kbId": KB, "scope": harness.scope},
                        expect_reply=False)
        probe = harness.command({"type": "datasets", "id": "ok-2", "action": "delete",
                                 "datasetId": "missing", "scope": harness.scope})
        assert probe["error"] == "DATASETS_NOT_FOUND"
        with harness._lock:
            ids = [frame["id"] for frame in harness.frames if frame.get("type") == "datasets"]
        assert "d-3" not in ids
    finally:
        harness.finish()


def test_datasets_commands_are_fenced_by_scope_and_authentication(tmp_path, monkeypatch) -> None:
    harness = make_datasets_harness(tmp_path, monkeypatch)
    harness.select_workspace(seeded_work(tmp_path))
    source = picked_file(tmp_path, 'table.csv', b'a,b\n1,2\n')
    harness.start()
    try:
        frame = harness.command({"type": "datasets", "id": "d-1", "action": "import",
                                 "path": source, "projectId": "", "scope": "0" * 64})
        assert frame["error"] == "DATASETS_IDENTITY_CHANGED"
        assert frame["result"] is None
        harness.login_state["value"] = "unauthenticated"
        frame = harness.command({"type": "datasets", "id": "d-2", "action": "import",
                                 "path": source, "projectId": "", "scope": harness.scope})
        assert frame["error"] == "DATASETS_UNAUTHENTICATED"
    finally:
        harness.finish()


def test_delete_round_trip_removes_the_row_and_keeps_the_file(tmp_path, monkeypatch) -> None:
    harness = make_datasets_harness(tmp_path, monkeypatch)
    harness.select_workspace(seeded_work(tmp_path))
    harness.start()
    try:
        content = b'a,b\n1,2\n'
        source = picked_file(tmp_path, 'table.csv', content)
        frame = harness.command({"type": "datasets", "id": "d-1", "action": "import",
                                 "path": source, "projectId": PROJECT, "scope": harness.scope})
        dataset_id = frame["result"]["datasetId"]
        frame = harness.command({"type": "datasets", "id": "d-2", "action": "delete",
                                 "datasetId": dataset_id, "scope": harness.scope})
        assert frame["error"] == ""
        assert frame["result"]["deleted"] is True
        harness.wait_for_status(lambda frame: frame["datasets"] == [])
        assert Path(source).read_bytes() == content
        frame = harness.command({"type": "datasets", "id": "d-3", "action": "delete",
                                 "datasetId": dataset_id, "scope": harness.scope})
        assert frame["error"] == "DATASETS_NOT_FOUND"
    finally:
        harness.finish()


def test_corrupt_import_records_a_failed_row_the_status_frame_parses(tmp_path, monkeypatch) -> None:
    """The exact crash-loop hole (#102 review): a real corrupt import records
    a failed row, the wire reply settles as failed, and the 0.5 s status
    frames carrying that failed row keep parsing — a persisted failed row
    must never kill the child or re-kill every restarted one."""
    harness = make_datasets_harness(tmp_path, monkeypatch)
    harness.select_workspace(seeded_work(tmp_path))
    harness.start()
    try:
        source = picked_file(tmp_path, 'broken.xlsx', b'PK\x03\x04truncated')
        frame = harness.command({"type": "datasets", "id": "d-1", "action": "import",
                                 "path": source, "projectId": PROJECT, "scope": harness.scope})
        assert frame["error"] == ""
        assert frame["result"]["failed"] is True
        assert frame["result"]["errorCode"] == DATASETS_PARSE_FAILED
        status = harness.wait_for_status(lambda frame: len(frame["datasets"]) == 1)
        # The failed row's honest wire shape, exactly as the registry emits it.
        row = status["datasets"][0]
        assert row["status"] == "failed"
        assert row["format"] == "xlsx"
        assert row["errorCode"] == DATASETS_PARSE_FAILED
        assert row["sheets"] == []
        # The status loop keeps ticking with the failed row persisted: the
        # shipped wire validator accepts it instead of killing the child.
        harness.wait_for_more_status_frames(harness.status_frame_count())
        assert harness.finish() == 0
    finally:
        if harness._thread.is_alive():
            harness.finish()

