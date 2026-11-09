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

# Issue #120 design decisions (settled before code)

## D1 — A system-axis sibling, not a ledger extension

The #89 ledger records layers × capability and its update protocol is
candidate-driven ("只更新该候选实际触达的行"). #120 needs systems × capability —
a different axis with a different update cadence (Win7 专项 lands in one future
batch, modern cells drift with candidates). Extending `capability-ledger.json`
with a per-system layer would entangle two protocols in one file and force a
second validator into the ledger's locked schema. So the matrix is a sibling
artifact (`system-matrix.json`) whose row set is **not re-enumerated**: the
verifier reads the shipped ledger and locks row count/id/kind/name against it.
A #70 sub-ticket change trips `verify:ledger`; matrix drift from the ledger
trips `verify:matrix`. Each framework keeps one authority.

## D2 — Lockstep on the modern column, divergence must say why

All acceptance so far happened on modern Windows, so the ledger's
candidateAcceptance layer IS the modern story. To avoid double bookkeeping
drift, the matrix's modernWindows cells mirror that layer verbatim, and the
validator enforces equality — a differing status is invalid unless the cell
carries a note explaining why (e.g. ledger update lag). Initial accounting has
zero divergence. The matrix can never run ahead of the ledger narrative.

## D3 — Execution entries are the deliverable, not decoration

T131-01 requires "逐项登记责任人与执行入口" before any scenario runs. A matrix
of 92 identical 未执行 cells would be honest but useless; per-cell registered
entries (automated test paths, whitelisted commands, T131/W7 scenario anchors,
bounded manual walkthroughs) are what make each grid executable later. Hence
the rule that open win7 cells must keep a scenario anchor, and every open cell
must register at least one entry. Entries are registration, never evidence —
`未记录` stays zero-evidence.

## D4 — 不硬凑 as a validator rule

"上不了 Win7 的能力逐项明示（不硬凑、不默默砍）" becomes machinery: a
capability row may claim win7 `不适用` only with in-tree incompatibility
evidence attached plus a reason note; on modern Windows a capability row can
never opt out (it must be attempted there first). 不适用 is otherwise reserved
for 治理 rows, mirroring the ledger's reservation.

## D5 — Stack integration base, disclosed

#120's blockers (#119/#88 + the ledger from #89) were complete but unmerged.
Merging them myself is not my call; waiting idle helps nobody. The branch
merges the three PR branches into its base as explicit merge commits, keeps the
#120-specific diff cleanly separated on top, and the PR states the merge-order
constraint (162/163/164 first). The three branches were authored to coexist
(#163: "对 PR #162 的 occt 重打包方向兼容，合并顺序无约束"; #164: "本 PR 刻意不碰
工作流文件"), so the union is designed-for. Conflict surface seen: two
`.gitattributes` hunks (union kept #162's superset) and package.json scripts
(union). All three verifiers pass on the base before any #120 work started.

## D6 — Governance rows keep their ledger semantics

p6-47 (this ticket) and p6-48 (#89 framework) stay 治理 in the matrix. p6-48 is
不适用 on both systems with a reason note (the framework has no installed
surface), mirroring the ledger. p6-47 stays 未记录/未执行 with `T131-01` as its
win7 anchor — this matrix is literally T131-01's traceability-matrix row
source, so the ticket points at itself honestly.
