"""Device-side document parsing engine (#81).

Real local extraction for the formats the device claims to support, replacing
the register-the-suffix-only behavior: PDF (pypdf), DOCX and XLSX (OOXML
parts via the standard zip/XML machinery), CSV, and decodable text. The
engine is a pure, deterministic function of (bytes, filename, parser version):
the same inputs always produce the same text, layout anchors, and reason
codes, so a recorded citation can later be re-validated by re-parsing
hash-verified bytes. The caller records the source SHA-256 alongside the
parser identity; nothing here touches the network, the filesystem, or the
workspace boundary.

Results never raise for content problems. A document the device cannot
honestly extract answers with a fixed reason code (``PARSE_*``), and legacy
binary formats (.doc/.xls/.ppt) answer ``skipped`` instead of pretending:
they stay registrable under the frozen platform whitelist, but their record
says the device did not parse them and points at the explicit platform
parsing entry (the publish flow).
"""
from __future__ import annotations

import csv
import io
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any

try:  # The packaged runtime ships pypdf; a degraded install must not crash the process.
    from pypdf import PdfReader
    from pypdf import __version__ as _PYPDF_VERSION
except ImportError:  # pragma: no cover - exercised via monkeypatch in tests
    PdfReader = None
    _PYPDF_VERSION = ""

# Aligned with the frozen #112 import bound: the engine refuses the same
# per-file ceiling the import already enforces (defense in depth).
MAX_PARSE_FILE_BYTES = 50 * 1024 * 1024
MAX_PARSE_TEXT_CHARS = 400_000
MAX_PARSE_LINES = 200_000
MAX_PARSE_LAYOUT_ENTRIES = 5_000

TEXT_PARSER = "text-utf8"
CSV_PARSER = "csv-stdlib"
DOCX_PARSER = "docx-ooxml"
XLSX_PARSER = "xlsx-ooxml"
STRUCTURED_PARSER_VERSION = "1"

_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_X = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_XR = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

_TEXT_EXTENSIONS = frozenset({".txt", ".md", ".json"})


def parse_document(raw: bytes, filename: str) -> dict[str, Any]:
    """Parse one document's bytes and return its text, layout, and identity.

    The returned layout anchors reference the produced text's own lines
    (1-based): a ``page`` or ``table`` entry marks where that page or table
    starts and how many text lines it spans, which is what later retrieval
    citations resolve against.
    """
    if len(raw) > MAX_PARSE_FILE_BYTES:
        return {"status": "failed", "parser": "", "parser_version": "", "reason": "PARSE_FILE_TOO_LARGE"}
    suffix = Path(filename).suffix.lower()
    if suffix == ".pdf":
        return _parse_pdf(raw)
    if suffix == ".docx":
        return _parse_docx(raw)
    if suffix == ".xlsx":
        return _parse_xlsx(raw)
    if suffix == ".csv":
        return _parse_csv(raw)
    if suffix in _TEXT_EXTENSIONS:
        return _parse_text(raw)
    return {"status": "skipped", "reason": "PARSE_FORMAT_UNSUPPORTED"}


def parse_summary(result: dict[str, Any]) -> dict[str, Any]:
    """The bounded per-document parse record kept with the import display facts.

    Positions are not duplicated here: the layout is re-derivable by parsing
    the hash-verified bytes with the recorded parser version, so the record
    keeps the identity (parser, version), the page/table counts, and the
    honest outcome.
    """
    layout = result.get("layout") or []
    return {
        "status": result.get("status", "failed"),
        "parser": result.get("parser", ""),
        "parserVersion": result.get("parser_version", ""),
        "pages": sum(1 for entry in layout if entry.get("kind") == "page"),
        "tables": sum(1 for entry in layout if entry.get("kind") == "table"),
        "truncated": bool(result.get("truncated", False)),
        "errorCode": result.get("reason", ""),
    }


def _failure(parser: str, version: str, reason: str) -> dict[str, Any]:
    return {"status": "failed", "parser": parser, "parser_version": version, "reason": reason}


def _decode(raw: bytes, parser: str, version: str) -> dict[str, Any] | str:
    """Strict UTF-8 with the same binary refusal the frozen retrieval uses."""
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return _failure(parser, version, "PARSE_TEXT_DECODE_FAILED")
    if "\x00" in text:
        return _failure(parser, version, "PARSE_TEXT_DECODE_FAILED")
    return text


def _assemble(lines: list[str], spans: list[tuple[str, int | None, int | None, str | None, int, int]],
              cut: bool) -> dict[str, Any]:
    """Join extracted lines under the display bounds and clip layout anchors."""
    kept: list[str] = []
    total = 0
    truncated = cut
    for line in lines:
        addition = len(line) + (1 if kept else 0)
        if total + addition > MAX_PARSE_TEXT_CHARS:
            if not kept:
                kept.append(line[:MAX_PARSE_TEXT_CHARS])
            truncated = True
            break
        kept.append(line)
        total += addition
    layout: list[dict[str, Any]] = []
    for kind, page, table, title, start, count in spans:
        end = min(start + count - 1, len(kept))
        if end < start:
            continue
        layout.append({"kind": kind, "page": page, "table": table, "title": title,
                       "line": start, "lines": end - start + 1})
    if len(layout) > MAX_PARSE_LAYOUT_ENTRIES:
        layout = layout[:MAX_PARSE_LAYOUT_ENTRIES]
        truncated = True
    return {"text": "\n".join(kept), "layout": layout, "truncated": truncated}


def _parse_text(raw: bytes) -> dict[str, Any]:
    decoded = _decode(raw, TEXT_PARSER, STRUCTURED_PARSER_VERSION)
    if not isinstance(decoded, str):
        return decoded
    if len(decoded) > MAX_PARSE_TEXT_CHARS:
        return {"status": "parsed", "parser": TEXT_PARSER, "parser_version": STRUCTURED_PARSER_VERSION,
                "text": decoded[:MAX_PARSE_TEXT_CHARS], "layout": [], "truncated": True}
    return {"status": "parsed", "parser": TEXT_PARSER, "parser_version": STRUCTURED_PARSER_VERSION,
            "text": decoded, "layout": [], "truncated": False}


def _parse_csv(raw: bytes) -> dict[str, Any]:
    decoded = _decode(raw, CSV_PARSER, STRUCTURED_PARSER_VERSION)
    if not isinstance(decoded, str):
        return decoded
    rows = list(csv.reader(io.StringIO(decoded)))[:MAX_PARSE_LINES]
    lines = ["\t".join(row) for row in rows]
    spans = [("table", None, 1, None, 1, len(lines))] if lines else []
    return {"status": "parsed", "parser": CSV_PARSER, "parser_version": STRUCTURED_PARSER_VERSION,
            **_assemble(lines, spans, len(rows) == MAX_PARSE_LINES)}


def _xml_part(archive: zipfile.ZipFile, name: str) -> ET.Element | None:
    """One zip part parsed as OOXML XML; DOCTYPEs are refused, not expanded."""
    info = archive.getinfo(name)
    if info.file_size > MAX_PARSE_FILE_BYTES:
        raise zipfile.BadZipFile(name)
    data = archive.read(name)
    if b"<!DOCTYPE" in data[:4096] or b"<!ENTITY" in data[:4096]:
        raise ET.ParseError(name)
    return ET.fromstring(data)


def _cell_text(cell: ET.Element, shared: list[str]) -> str:
    kind = cell.get("t")
    if kind == "inlineStr":
        inline = cell.find(f"{{{_X}}}is")
        return "".join(node.text or "" for node in inline.iter(f"{{{_X}}}t")) if inline is not None else ""
    value = cell.find(f"{{{_X}}}v")
    if value is None or value.text is None:
        return ""
    if kind == "s":
        try:
            index = int(value.text)
        except ValueError:
            return ""
        return shared[index] if 0 <= index < len(shared) else ""
    return value.text


def _parse_docx(raw: bytes) -> dict[str, Any]:
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            body = _xml_part(archive, "word/document.xml").find(f"{{{_W}}}body")
    except (zipfile.BadZipFile, KeyError, OSError, ET.ParseError):
        return _failure(DOCX_PARSER, STRUCTURED_PARSER_VERSION, "PARSE_DOCX_CORRUPT")
    if body is None:
        return _failure(DOCX_PARSER, STRUCTURED_PARSER_VERSION, "PARSE_DOCX_CORRUPT")
    lines: list[str] = []
    spans: list[tuple[str, int | None, int | None, str | None, int, int]] = []
    tables = 0
    cut = False
    for child in body:
        if child.tag == f"{{{_W}}}p":
            if len(lines) < MAX_PARSE_LINES:
                lines.append("".join(node.text or "" for node in child.iter(f"{{{_W}}}t")))
            else:
                cut = True
        elif child.tag == f"{{{_W}}}tbl":
            tables += 1
            start = len(lines) + 1
            count = 0
            for row in child.findall(f"{{{_W}}}tr"):
                if len(lines) < MAX_PARSE_LINES:
                    cells = ["".join(node.text or "" for node in cell.iter(f"{{{_W}}}t"))
                             for cell in row.findall(f"{{{_W}}}tc")]
                    lines.append("\t".join(cells))
                else:
                    cut = True
                count += 1
            spans.append(("table", None, tables, None, start, count))
    return {"status": "parsed", "parser": DOCX_PARSER, "parser_version": STRUCTURED_PARSER_VERSION,
            **_assemble(lines, spans, cut)}


def _parse_xlsx(raw: bytes) -> dict[str, Any]:
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            workbook = _xml_part(archive, "xl/workbook.xml")
            relationships = _xml_part(archive, "xl/_rels/workbook.xml.rels")
            shared: list[str] = []
            if "xl/sharedStrings.xml" in archive.namelist():
                strings = _xml_part(archive, "xl/sharedStrings.xml")
                shared = ["".join(node.text or "" for node in item.iter(f"{{{_X}}}t"))
                          for item in strings.findall(f"{{{_X}}}si")]
            targets = {element.get("Id"): element.get("Target") or ""
                       for element in relationships}
            sheets = []
            for sheet in workbook.iter(f"{{{_X}}}sheet"):
                name = sheet.get("name") or ""
                target = targets.get(sheet.get(f"{{{_XR}}}id") or "", "").lstrip("/")
                if target and not target.startswith("xl/"):
                    target = f"xl/{target}"
                sheets.append((name, target))
            # An unresolved target is a corrupt workbook, not a missing sheet.
            parts = [(name, _xml_part(archive, target)) for name, target in sheets]
    except (zipfile.BadZipFile, KeyError, OSError, ET.ParseError, ValueError):
        return _failure(XLSX_PARSER, STRUCTURED_PARSER_VERSION, "PARSE_XLSX_CORRUPT")
    lines: list[str] = []
    spans: list[tuple[str, int | None, int | None, str | None, int, int]] = []
    cut = False
    for table_number, (name, sheet) in enumerate(parts, 1):
        start = len(lines) + 1
        lines.append(f"# Sheet: {name}")
        data = sheet.find(f"{{{_X}}}sheetData")
        for row in (data.findall(f"{{{_X}}}row") if data is not None else []):
            if len(lines) < MAX_PARSE_LINES:
                cells = [_cell_text(cell, shared) for cell in row.findall(f"{{{_X}}}c")]
                lines.append("\t".join(cells))
            else:
                cut = True
        spans.append(("table", None, table_number, name, start, len(lines) - start + 1))
    return {"status": "parsed", "parser": XLSX_PARSER, "parser_version": STRUCTURED_PARSER_VERSION,
            **_assemble(lines, spans, cut)}


def _parse_pdf(raw: bytes) -> dict[str, Any]:
    if PdfReader is None:
        return _failure("pypdf", "", "PARSE_PDF_UNAVAILABLE")
    try:
        reader = PdfReader(io.BytesIO(raw))
        if reader.is_encrypted:
            return _failure("pypdf", _PYPDF_VERSION, "PARSE_PDF_ENCRYPTED")
        page_texts = [page.extract_text() or "" for page in reader.pages]
    except Exception:  # pypdf failure surface is wide; the fixed reason is the boundary.
        return _failure("pypdf", _PYPDF_VERSION, "PARSE_PDF_CORRUPT")
    lines: list[str] = []
    spans: list[tuple[str, int | None, int | None, str | None, int, int]] = []
    cut = False
    for number, page_text in enumerate(page_texts, 1):
        start = len(lines) + 1
        page_lines = page_text.splitlines()
        for line in page_lines:
            if len(lines) < MAX_PARSE_LINES:
                lines.append(line)
            else:
                cut = True
        spans.append(("page", number, None, None, start, len(lines) - start + 1))
    return {"status": "parsed", "parser": "pypdf", "parser_version": _PYPDF_VERSION,
            **_assemble(lines, spans, cut)}
