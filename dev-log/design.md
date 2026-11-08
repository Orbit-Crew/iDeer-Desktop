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
