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

import pytest

from core.document_parse import (
    MAX_PARSE_FILE_BYTES,
    MAX_PARSE_TEXT_CHARS,
    parse_document,
    parse_summary,
)
from fixtures.document_fixtures import (
    build_docx,
    build_pdf,
    build_xlsx,
    docx_paragraph,
    docx_table,
    xlsx_row,
    xlsx_sheet,
)


def test_plain_text_preserves_lines_and_has_no_layout():
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


def test_docx_oversized_inner_part_is_not_called_corrupt():
    raw = build_docx(docx_paragraph("a" * (MAX_PARSE_FILE_BYTES + 1)))
    result = parse_document(raw, "bomb.docx")
    assert result["status"] == "failed"
    assert result["reason"] == "PARSE_PART_TOO_LARGE"


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


def test_pdf_pages_without_a_text_layer_still_count():
    """A scanned document is honestly parsed: pages exist, the text is empty."""
    result = parse_document(build_pdf(["", ""]), "scan.pdf")
    assert result["status"] == "parsed"
    assert result["text"] == ""
    assert result["layout"] == [
        {"kind": "page", "page": 1, "table": None, "title": None, "line": 1, "lines": 0},
        {"kind": "page", "page": 2, "table": None, "title": None, "line": 1, "lines": 0}]
    summary = parse_summary(result)
    assert summary["pages"] == 2
    assert summary["errorCode"] == ""


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


def test_csv_at_the_exact_line_cap_is_not_marked_truncated():
    raw = ("a\n" * 200_000).encode("utf-8")
    result = parse_document(raw, "edge.csv")
    assert result["status"] == "parsed"
    assert result["truncated"] is False


def test_parsing_is_deterministic_for_identical_bytes():
    raw = build_pdf(["same bytes same result"])
    assert parse_document(raw, "a.pdf") == parse_document(raw, "a.pdf")


def test_summary_records_layout_anchors_with_the_parser_identity():
    parsed = parse_summary(parse_document(b"a,b\n1,2\n", "t.csv"))
    assert parsed == {"status": "parsed", "parser": "csv-stdlib", "parserVersion": "1",
                      "pages": 0, "tables": 1, "truncated": False, "errorCode": "",
                      "layout": [{"kind": "table", "page": None, "table": 1, "title": None,
                                  "line": 1, "lines": 2}]}
    failed = parse_summary({"status": "failed", "reason": "PARSE_PDF_CORRUPT"})
    assert failed == {"status": "failed", "parser": "", "parserVersion": "",
                      "pages": 0, "tables": 0, "truncated": False,
                      "errorCode": "PARSE_PDF_CORRUPT", "layout": []}
    skipped = parse_summary({"status": "skipped", "reason": "PARSE_FORMAT_UNSUPPORTED"})
    assert skipped["status"] == "skipped"
    assert skipped["errorCode"] == "PARSE_FORMAT_UNSUPPORTED"
    assert skipped["layout"] == []
