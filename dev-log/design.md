# Issue #98 design decisions (settled before code)

## D1 — One answering seam; only the projection differs

`answer_frozen_revision` in `knowledge_search.py` is the shared engine
decision (BM25 when the index covers the whole revision and the query
tokenizes, the literal scan otherwise with a visible `fallbackReason`). The
broker task (`file_service._search_knowledge`) and the user's own doc-library
search (`platform_chat.knowledge_search` → `search_registered_revision`)
ride the same seam, so a broker answer and a library answer can never drift
apart in what they verify or how they cite. The frozen-revision contract is
not weakened: every search still re-validates each manifest document against
the live bytes before anything is served, and the structured missing list
stays the honest gap report.

## D2 — Citations come only from the frozen parse's layout anchors

A hit cites a page (or table) only when the frozen parse's `document_layouts`
row anchors it: `page_for_line`/`table_for_line` mirror the #97 page marks,
a table is a bounded span (unlike a from-here-on page), a hit outside every
table span cites no table, and an unknown layout cites no page — never a
guessed page number. The literal engine consults the layout rows it reads
for that branch only; the BM25 branch carries the anchors inside its ranked
rows.

## D3 — Wire contracts stay additive or bounded

The broker result stays snake_case and additive (`library`, `evidenceComplete`,
`position.table`, plus the internal `servableUnknown` flag consumed by the
seam before the broker ever sees the result). The user-facing view
(`search_registered_revision` → `project_search_view`) is bounded camelCase;
documents are cited by their frozen (filename, content hash) identity — the
registry never stores platform document ids, so none are invented.

## D4 — The device answers offline; credentials ride as a summary

Device-side retrieval never calls the Server: an offline device still answers
its own question, and the retrieval credentials ride as the binding summary
(origin/user/device) — public keys never cross the bridge. Honesty flags:
`evidenceComplete` is false whenever a document is missing, the answer was
cut, or servability could not be determined; the QA graph surface marks a
partial/failed scope 依据不完整 instead of faking a complete answer.

## D5 — The user's search earns a durable device record

The user library search writes one append-only audit row at the seam before
the reply leaves it: the query stays out of the row (its digest only), a
broken audit log fails the answer closed (an untraceable citation is never
emitted), the view names the record (`auditTaskId`) only when the row exists,
and the desktop dispatch threads its command id into the seam so the row,
the view, and the wire projection carry the same identity. The broker path
keeps its receipt chain (`receipt.result_hash` pins the exact cited result;
the ledger row binds the credential profile) — no receipt hash inside the
result, which would be circular.

## D6 — Zero new dependencies; one new IPC channel

No new dependency anywhere. One new control command (`knowledge-search`)
with an exact-shape gate in `desktop.py`, its single-slot queue, and the
security-test pin (`desktop:knowledge:search` channel + smoke bridge key),
following the #97 command ladder exactly.
