"""Shared document fixtures for the #81 parse-engine tests.

Each builder assembles a minimal real-format document in memory so tests
exercise genuine bytes without binary fixture files.
"""
from __future__ import annotations

import io
import zipfile

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
XLSX_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
XLSX_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"


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
    document = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                f'<w:document xmlns:w="{W_NS}"><w:body>{body_children}</w:body></w:document>')
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", document)
    return buffer.getvalue()


def docx_paragraph(text: str) -> str:
    return f'<w:p><w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'


def docx_table(rows: list[list[str]]) -> str:
    cells = "".join(
        "<w:tr>" + "".join(f"<w:tc><w:p><w:r><w:t>{cell}</w:t></w:r></w:p></w:tc>" for cell in row) + "</w:tr>"
        for row in rows)
    return f"<w:tbl>{cells}</w:tbl>"


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
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<Relationships xmlns="{PKG_REL}">{relationships}</Relationships>')
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
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
