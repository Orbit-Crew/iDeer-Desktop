"""Device-side document parsing engine (#81).

Every test feeds real bytes to the pure ``parse_document`` seam and asserts
the extracted text, the page/table layout anchors that reference the produced
text's own lines, and the bounded display record. Failure paths must answer
with a fixed reason code instead of raising or pretending: parsing is a
deterministic function of (bytes, filename, parser version), so the same
inputs always produce the same result and a recorded citation can be
re-validated later by re-parsing hash-verified bytes.
"""
from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest

from core.document_parse import (
    MAX_PARSE_FILE_BYTES,
    MAX_PARSE_TEXT_CHARS,
    parse_document,
    parse_summary,
)

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def build_pdf(page_texts):
    """Assemble a minimal uncompressed PDF with one text line per page."""
    objects = []
    font_id = 3 + 2 * len(page_texts)
    kids = " ".join(f"{3 + 2 * index} 0 R" for index in range(len(page_texts)))
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(page_texts)} >>".encode())
    for index, text in enumerate(page_texts):
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {4 + 2 * index} 0 R"
            f" /Resources << /Font << /F1 {font_id} 0 R >> >> >>".encode())
        stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode("latin-1")
        objects.append(f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream")
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_at = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode() + b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF").encode()
    return bytes(out)


def build_docx(body_children: str) -> bytes:
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{W_NS}"><w:body>{body_children}</w:body></w:document>')
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("word/document.xml", document)
    return buffer.getvalue()


def docx_paragraph(text: str) -> str:
    return f'<w:p><w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'


def docx_table(rows: list[list[str]]) -> str:
    cells = "".join(
        "<w:tr>" + "".join(f"<w:tc><w:p><w:r><w:t>{cell}</w:t></w:r></w:p></w:tc>" for cell in row) + "</w:tr>"
        for row in rows)
    return f"<w:tbl>{cells}</w:tbl>"


XLSX_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
XLSX_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"


def build_xlsx(sheets: list[tuple[str, str]], shared: list[str] | None = None) -> bytes:
    """One minimal workbook: sheets carry inline strings, numbers, or shared indices."""
    sheet_tags = "".join(
        f'<sheet name="{name}" sheetId="{index + 1}" r:id="rId{index + 1}" />'
        for index, (name, _xml) in enumerate(sheets))
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<workbook xmlns="{XLSX_MAIN}" xmlns:r="{XLSX_REL}"><sheets>{sheet_tags}</sheets></workbook>')
    relationships = "".join(
        f'<Relationship Id="rId{index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
        f'relationships/worksheet" Target="worksheets/sheet{index + 1}.xml" />'
        for index in range(len(sheets)))
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<Relationships xmlns="{PKG_REL}">{relationships}</Relationships>')
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", rels)
        for index, (_name, xml) in enumerate(sheets):
            archive.writestr(f"xl/worksheets/sheet{index + 1}.xml", xml)
        if shared is not None:
            items = "".join(f"<si><t>{text}</t></si>" for text in shared)
            archive.writestr("xl/sharedStrings.xml",
                             f'<?xml version="1.0"?><sst xmlns="{XLSX_MAIN}" count="{len(shared)}" uniqueCount="{len(shared)}">{items}</sst>')
    return buffer.getvalue()


def xlsx_sheet(rows: str) -> str:
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<worksheet xmlns="{XLSX_MAIN}"><sheetData>{rows}</sheetData></worksheet>')


def xlsx_row(cells: list[tuple[str, str]]) -> str:
    return "<row>" + "".join(
        f'<c r="{ref}"{attr}>{inner}</c>' for ref, (attr, inner) in zip(("A", "B", "C"), cells)) + "</row>"


def test_plain_text_preserves_lines_and_has_no_layout(tmp_path: Path):
    result = parse_document("# marker\nfirst line\nsecond line\n".encode("utf-8"), "notes.txt")
    assert result["status"] == "parsed"
    assert result["parser"] == "text-utf8"
    assert result["parser_version"] == "1"
    assert result["text"] == "# marker\nfirst line\nsecond line\n"
    assert result["layout"] == []
    assert result["truncated"] is False


def test_markdown_and_json_ride_the_text_parser():
    for filename in ("guide.md", "data.json"):
        result = parse_document('{"a": 1}\n'.encode("utf-8"), filename)
        assert result["status"] == "parsed"
        assert result["parser"] == "text-utf8"
        assert result["text"] == '{"a": 1}\n'


def test_binary_text_file_reports_decode_failure():
    result = parse_document(b"\x00\x01\x02binary\x00", "blob.txt")
    assert result["status"] == "failed"
    assert result["reason"] == "PARSE_TEXT_DECODE_FAILED"
    assert "text" not in result


def test_csv_produces_one_table_layout_with_row_anchors():
    raw = b"name,qty\nbearing,4\ngear,2\n"
    result = parse_document(raw, "parts.csv")
    assert result["status"] == "parsed"
    assert result["parser"] == "csv-stdlib"
    assert result["text"] == "name\tqty\nbearing\t4\ngear\t2"
    assert result["layout"] == [{"kind": "table", "page": None, "table": 1, "title": None, "line": 1, "lines": 3}]


def test_docx_paragraphs_and_real_table_positions():
    body = (docx_paragraph("intro line")
            + docx_paragraph("")
            + docx_table([["part", "qty"], ["bearing", "4"]])
            + docx_paragraph("after table"))
    result = parse_document(build_docx(body), "report.docx")
    assert result["status"] == "parsed"
    assert result["parser"] == "docx-ooxml"
    assert result["text"] == "intro line\n\npart\tqty\nbearing\t4\nafter table"
    assert result["layout"] == [
        {"kind": "table", "page": None, "table": 1, "title": None, "line": 3, "lines": 2}]


def test_docx_corrupt_archive_reports_honest_reason():
    result = parse_document(b"PK\x03\x04truncated", "broken.docx")
    assert result["status"] == "failed"
    assert result["reason"] == "PARSE_DOCX_CORRUPT"


def test_xlsx_sheets_become_tables_with_titles_and_shared_strings():
    rows = (xlsx_row([(' t="inlineStr"', '<is><t>part</t></is>'), ('', '<v>4</v>'), (' t="s"', '<v>0</v>')])
            + xlsx_row([(' t="inlineStr"', '<is><t>gear</t></is>'), ('', '<v>2</v>'), (' t="s"', '<v>0</v>')]))
    raw = build_xlsx([("库存", xlsx_sheet(rows)), ("Empty", xlsx_sheet(""))], shared=["部件"])
    result = parse_document(raw, "book.xlsx")
    assert result["status"] == "parsed"
    assert result["parser"] == "xlsx-ooxml"
    assert result["text"] == "# Sheet: 库存\npart\t4\t部件\ngear\t2\t部件\n# Sheet: Empty"
    assert result["layout"] == [
        {"kind": "table", "page": None, "table": 1, "title": "库存", "line": 1, "lines": 3},
        {"kind": "table", "page": None, "table": 2, "title": "Empty", "line": 4, "lines": 1}]


def test_xlsx_corrupt_archive_reports_honest_reason():
    result = parse_document(b"PK\x03\x04truncated", "broken.xlsx")
    assert result["status"] == "failed"
    assert result["reason"] == "PARSE_XLSX_CORRUPT"


def test_pdf_pages_carry_real_page_anchors():
    result = parse_document(build_pdf(["Hello page one", "Hello page two"]), "manual.pdf")
    assert result["status"] == "parsed"
    assert result["parser"] == "pypdf"
    assert result["parser_version"] == pytest.importorskip("pypdf").__version__
    assert "Hello page one" in result["text"]
    assert "Hello page two" in result["text"]
    assert result["layout"] == [
        {"kind": "page", "page": 1, "table": None, "title": None, "line": 1, "lines": 1},
        {"kind": "page", "page": 2, "table": None, "title": None, "line": 2, "lines": 1}]


def test_pdf_encrypted_reports_honest_reason():
    from pypdf import PdfWriter
    writer = PdfWriter()
    writer.add_blank_page(200, 200)
    writer.encrypt(user_password="secret")
    buffer = io.BytesIO()
    writer.write(buffer)
    result = parse_document(buffer.getvalue(), "locked.pdf")
    assert result["status"] == "failed"
    assert result["reason"] == "PARSE_PDF_ENCRYPTED"


def test_pdf_corrupt_bytes_report_honest_reason():
    result = parse_document(b"%PDF-1.7\nnot really a pdf", "broken.pdf")
    assert result["status"] == "failed"
    assert result["reason"] == "PARSE_PDF_CORRUPT"


def test_pdf_without_pypdf_reports_unavailable(monkeypatch: pytest.MonkeyPatch):
    import core.document_parse as module
    monkeypatch.setattr(module, "PdfReader", None)
    result = parse_document(b"%PDF-1.4\n", "manual.pdf")
    assert result["status"] == "failed"
    assert result["reason"] == "PARSE_PDF_UNAVAILABLE"


def test_legacy_format_is_skipped_not_faked():
    result = parse_document(b"\xd0\xcf\x11\xe0legacy", "old.doc")
    assert result["status"] == "skipped"
    assert result["reason"] == "PARSE_FORMAT_UNSUPPORTED"
    assert parse_summary(result)["errorCode"] == "PARSE_FORMAT_UNSUPPORTED"


def test_oversized_input_is_refused_before_parsing():
    result = parse_document(b"x" * (MAX_PARSE_FILE_BYTES + 1), "big.txt")
    assert result["status"] == "failed"
    assert result["reason"] == "PARSE_FILE_TOO_LARGE"


def test_text_truncation_is_marked_not_silent():
    raw = ("word\n" * (MAX_PARSE_TEXT_CHARS // 5 + 8)).encode("utf-8")
    result = parse_document(raw, "long.txt")
    assert result["status"] == "parsed"
    assert result["truncated"] is True
    assert len(result["text"]) == MAX_PARSE_TEXT_CHARS


def test_parsing_is_deterministic_for_identical_bytes():
    raw = build_pdf(["same bytes same result"])
    assert parse_document(raw, "a.pdf") == parse_document(raw, "a.pdf")


def test_summary_maps_every_status_to_a_bounded_record():
    parsed = parse_summary(parse_document(b"a,b\n1,2\n", "t.csv"))
    assert parsed == {"status": "parsed", "parser": "csv-stdlib", "parserVersion": "1",
                      "pages": 0, "tables": 1, "truncated": False, "errorCode": ""}
    failed = parse_summary({"status": "failed", "reason": "PARSE_PDF_CORRUPT"})
    assert failed == {"status": "failed", "parser": "", "parserVersion": "",
                      "pages": 0, "tables": 0, "truncated": False, "errorCode": "PARSE_PDF_CORRUPT"}
    skipped = parse_summary({"status": "skipped", "reason": "PARSE_FORMAT_UNSUPPORTED"})
    assert skipped["status"] == "skipped"
    assert skipped["errorCode"] == "PARSE_FORMAT_UNSUPPORTED"
