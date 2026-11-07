# Issue #97 two-axis review (before push)

Two parallel review passes over `git diff 29df1e2..HEAD` — one against the
repo's documented standards and established idioms, one against the issue's
acceptance criteria — followed by fixes and re-verification.

## Spec axis — findings and dispositions

1. **Drift count could be erased by a subset search** (fixed): `observe_drift`
   overwrote the revision's drifted count with whatever the latest search
   observed, so a later subset search with no drift reset 已过期 to 0.
   Replaced with per-document drift marks (`knowledge_index_documents.drift`,
   derived `driftedDocuments = SUM(drift)`): a search adds marks for the
   documents it saw drift and clears the mark only for a document it actually
   verified (its bytes matched the frozen digest at that moment); a subset
   search never touches documents it did not look at. The rebuild rewrites
   every row with its recomputed truth. Pinned by
   `test_subset_search_never_erases_the_drift_annotation`.
2. **Same-name documents merged in the index search** (fixed): folder imports
   dedup by content digest only, so one revision can hold two documents with
   the same basename; the store's BM25 search keyed `weights`/`lengths` by
   filename alone, merging their term rows and dropping one document from the
   ranking. All per-document structures are now keyed by the full
   `(filename, content_hash)` identity. Pinned by
   `test_same_name_documents_are_served_separately`.
3. **Verified-but-unservable documents vanished** (fixed): a document whose
   bytes verify but that the index cannot honestly serve (skipped/failed
   parse at import) was neither in `chunks` nor `missing` and was counted as
   matched. The indexed path now classifies it as structured missing
   `not_searchable` — the same answer the literal engine gives — via the
   store's `servable_identities`. Pinned by
   `test_verified_unparsable_document_is_not_searchable`.
4. **Lazy drift discovery** (accepted, documented): the annotation updates
   when drift is observed (a search or a rebuild) — there is no always-on
   digest prober. This is the same discovery model the literal engine always
   had (per-search revalidation); the doc library's 重建索引 button is the
   tool that makes the annotation current on demand. Recorded in the
   acceptance report's honest notes.

## Standards axis — findings and dispositions

1. **Dead import** (fixed): `category_for` was imported in the rebuild's
   `_run` and never used — removed.
2. **Cancel-button guard narrower than its label** (fixed): 取消重建 keyed on
   `revisionId` only while the 重建中 label also matches `manifestHash`; the
   button now matches both.
3. **Snapshot join inconsistencies** (fixed): the per-row index join ran over
   all rows and `break`-ed on a store error (later rows carried no `index`
   key at all) and computed views for rows the `[:20]` slice then discarded;
   the join now runs over the sliced rows, and a failing read reads as
   `index: None` per row instead of dropping the tail's facts.
4. **Duplicated `count` closure in runtime.ts** (accepted): the identical
   closure already exists in `parseKnowledgeFolderJob`; a third copy matches
   the file's established per-parser idiom, and extracting a shared helper
   would diverge from the neighboring shape mid-ladder.
5. **Chunked-IN query repetition in `store.search`** (accepted): the two
   passes differ (df aggregation vs weight fetch); the shared shape is the
   SQLite parameter-bound chunking itself.
6. **`overflow = [False]` closure cell and `_rebuild_document`'s 4-tuple**
   (accepted): both are module-local, documented workarounds; the serve
   callback's boolean return is what keeps the single-read property, and
   splitting the tuple into a dataclass would add ceremony without a second
   consumer.

No hard standards breaches: stdlib-only Python, no new npm dependencies, fixed
uppercase categories across every boundary, exact-shape gates with updated
security pins, workspace-store-guarded reads only, physical paths never
crossing to the renderer or the wire.
