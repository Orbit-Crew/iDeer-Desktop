# Issue #97 design decisions (settled before code)

## D1 — Index identity and storage: sqlite `KnowledgeIndexStore` in new `core/knowledge_index.py`

One sqlite file next to the settings (`knowledge-index.db` via `config.with_name`), the
`KnowledgeImportRegistry` idiom: own `threading.RLock`, `PRAGMA synchronous=FULL`, one fixed
storage-error category (`KNOWLEDGE_INDEX_STORAGE_UNAVAILABLE`), per-call instantiation where the
service reads it (the registry is instantiated per search too; SQLite's busy timeout is the
cross-instance synchronization, same as today).

Rows are keyed by the **encoded binding + revision_id + manifest_hash** — the exact
`find_registration` discipline. kb_id is NOT part of the key because the search task does not
carry it; (binding, revision_id, manifest_hash) is already unique per registered revision.

Three tables: `knowledge_index_revisions` (document_count/drifted_documents/built_at/error),
`knowledge_index_documents` (per manifest document: servable flag, char_count, note, text, layout
JSON), `knowledge_index_terms` (per document+term: tf, bounded line list, indexed by term for df).

## D2 — State is derived, never stored as a claim

`revision_view` computes the state from the rows: `ready` only while every manifest document has a
row (`indexedDocuments >= documents > 0`), `partial` when some rows exist, `missing` when none, and
`failed` when an error is recorded on an incomplete revision. Nothing in the store says "ready" —
a half-written or crashed build can never impersonate completeness. `begin_revision` opens the
revision row at the first written document so a canceled or crashed rebuild shows its honest
partial state; `finish_revision` (completion only) refreshes the totals, drift, and built_at.

## D3 — The #113 revalidation contract is preserved, not weakened

`revalidate_frozen_documents` keeps the per-search walk + name match + SHA-256 comparison. The
`serve` callback receives the exact verified bytes (one read: digest and content come from the same
bytes — the literal scan's original TOCTOU-safe property), so the fallback path scans the same
bytes the digest verified. The indexed path uses the same classification and then answers intact
documents from the index, which was built from those same hash-verified frozen bytes at import
time. A drifted or gone document is structured `missing` exactly as before — the index is never a
license to answer from stale text.

## D4 — Drift is a per-document mark, never an overwriting count

The documents table carries a `drift` flag; `revision_view` derives
`driftedDocuments` from `SUM(drift)`. A search marks the documents it actually
observed — drifted marks are added, and a document the search verified (its
bytes matched the frozen digest at that moment) has its mark cleared. A later
subset search can therefore never erase the 已过期 annotation for documents it
did not look at, and a restored file's mark clears exactly when a search
re-verifies it. The rebuild rewrites every row with its recomputed truth.
(This replaced an earlier whole-revision overwrite that a subset search could
reset to zero — review finding, fixed before push.)

## D5 — Rebuild re-verifies; it never fakes drifted content

`KnowledgeIndexRebuild` (the `KnowledgeFolderImport` job idiom: one daemon thread, one slot,
`threading.Event` cancel checked per document, honest terminal states) re-reads every manifest
document, re-hashes it against the frozen digest, and re-indexes only what still verifies. A
drifted document keeps a non-servable row with `note='content_drift'` and its drift mark; the
frozen content it once had is gone and is NOT re-taken from current
bytes. Cancel keeps the rows written so far (each is self-consistent frozen content) and the
derived state shows `partial`.

## D6 — Import-time indexing via the transient `_text` field

`build_manifest`/`build_folder_entries` already parse every document; `_entry_with_text` keeps the
extracted text under `_text` on the manifest entry. `_register_frozen_entries` indexes the revision
right after the platform returns the revision identity (`_index_frozen_revision`), then
`strip_entry_text` drops the field in a `finally` — the wire payload (fixed field list) and the
registry rows (`DOCUMENT_FIELDS`) never see it. The folder job releases each batch's text as it
registers, bounding memory to one batch. An index failure never fails the registration (it is
recorded via `mark_build_error` and the store's storage error; retrieval falls back visibly).

## D7 — Tokenizer and BM25, stdlib-only and deterministic

ASCII `\w` runs stay whole casefolded words; contiguous non-ASCII word characters become
overlapping character bigrams (lone characters stay unigrams) — the recall/precision compromise
for Chinese text without a segmentation dependency. Terms are truncated at 40 chars consistently
for documents and queries. Per document: tf + first 200 line hits per term, ≤50k unique terms.
BM25 (k1=1.5, b=0.75, Lucene-style non-negative idf) ranks documents; chunks are the term-hit
lines of the ranked documents, each carrying the line number and the page resolved through the
frozen parse's layout anchors (`line_page_marks`). A query that tokenizes to nothing routes to the
literal scan (`fallbackReason: 'index-untokenized'`) so punctuation queries keep their capability.

## D8 — Index keying and the verified-but-unservable classification

Every per-document structure is keyed by the full `(filename, content_hash)` identity: a folder
import dedups by content digest only, so one revision can hold two same-name documents, and their
term rows, lengths, and BM25 scores must never merge (review finding, pinned by
`test_same_name_documents_are_served_separately`). A verified document the index cannot honestly
serve text for (it parsed as skipped or failed at import) is structured missing `not_searchable`
in the indexed path — the same answer the literal engine gives, never a silent gap and never
counted as matched (`test_verified_unparsable_document_is_not_searchable`).

## D9 — Wire: result annotations, not shape changes

`local.knowledge.search`'s result gains `engine` ('bm25' | 'literal'), `index` (the revision's
derived view), and — on the degraded path — `fallbackReason`. The receipt is content-hash based,
so additive keys are safe. No new capability name, no compat.ts change; the two new control
commands (`knowledge-index-rebuild`, `-cancel`) follow the exact-shape gate + single-slot queue +
scope fence idiom and required the sorted security-test channel pins plus the smoke bridge keys.

## D10 — Renderer: annotation on the doc library records

The per-row `index` view rides the snapshot's `knowledgeImports` rows; the one rebuild job rides as
`knowledgeIndexRebuild` (the folder-job pattern). The pane derives 重建中 (running job matching the
record's revisionId+manifestHash), 已过期 (driftedDocuments > 0 on top of ready/partial), and keeps
未建 / 未完成 / 失败 distinct — no vague merged word. Rebuild/cancel ride the existing
generation-fenced one-action controller; the explanations for the fixed `KNOWLEDGE_INDEX_*`
categories join the existing map.
