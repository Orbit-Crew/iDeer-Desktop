# Acceptance records

When reviewing issue completion, start with the relevant report below. Reports
bind their results to a candidate and environment; read their coverage limits
before applying an older result to newer code. GitHub issues track discussion
and link to these versioned records.

For the cross-issue picture, [the #89 capability ledger](capability-ledger.md)
accounts every #70 child capability on three layers (entry restoration,
business wiring, installed-candidate acceptance) with six-state scenario slots;
its machine-readable single source of truth is
[capability-ledger.json](capability-ledger.json) (`npm run verify:ledger`).
Issue open/closed state is never evidence there.

For the system axis (#120), [the capability × system matrix](system-matrix.md)
accounts every ledger row on 现代 Windows and Win7 with registered execution
entries; [system-matrix.json](system-matrix.json) is machine-readable, locked
to the ledger (`npm run verify:matrix`), and its outcome is mapped to the
[iDeer #131 retirement conditions](retirement-conditions.md).

## Issue #108

Start with [the #108 report](issue-108/report.md). Its latest entry links the
[2026-10-26 timeout resolution and re-acceptance](issue-108/timeout-resolution-20261026.md),
which explains the bug, fixes, scenario results, exact installer and remaining
platform verification.

- To check which code was tested and subsequently committed, read
  [the publication binding](issue-108/publication.json) and the report's candidate section.
- To inspect logs, screenshots, source bindings and before/after results, open
  [the current evidence directory](issue-108/evidence/timeout-resolution-20261026/).
- To repeat a scenario, use [the driver instructions](../../scripts/acceptance/issue-108/README.md).
- To understand an earlier failed attempt, read
  [the historical supplement](issue-108/supplement-20261026.md) and its evidence.
  The original C8 record remains in the main report.

The latest #108 runs cover modern Windows. Real Win7 remains unexecuted under
[iDeer #131](https://github.com/Orbit-Crew/iDeer/issues/131). The controlled
before/after diagnostic and the final uninstrumented installer runs are separate
evidence sets. Process-stop failure and drain deadlines have contract coverage;
the latest installed tests inject storage and unknown-effect failures.

## Other issue reports

These links locate existing records; this index does not change their verdicts.

| Issue | Report |
| --- | --- |
| #43 | [2026-10-30 driver UTF-8 verification](issue-43/report.md) |
| #71 | [2026-10-31 dock workspace entry restoration](issue-71/report.md) |
| #96–#104 | [#96](issue-96/report.md), [#97](issue-97/report.md), [#98](issue-98/report.md), [#99](issue-99/report.md), [#100](issue-100/report.md), [#101](issue-101/report.md), [#102](issue-102/report.md), [#103](issue-103/report.md), [#104](issue-104/report.md) |
| #105 | [Report](issue-105/report.md) |
| #106 | [Report](issue-106/report.md) |
| #107 | [Report](issue-107/report.md) |
| #109 | [Report](issue-109/report.md), [2026-10-26 installed recovery re-acceptance](issue-109/supplement-20261026.md) |
| #110 | [Report](issue-110/report.md) |
| #111 | [Report](issue-111/report.md), [2026-10-26 modern Windows acceptance with human signoff](issue-111/supplement-20261026.md) |
| #112–#123 | [#112](issue-112/report.md), [#113](issue-113/report.md), [#114](issue-114/report.md), [#115](issue-115/report.md), [#116](issue-116/report.md), [#117](issue-117/report.md), [#118](issue-118/report.md), [#119](issue-119/report.md), [#120](issue-120/report.md), [#121](issue-121/report.md), [#122](issue-122/report.md), [#123](issue-123/report.md), [2026-10-30 corrections, closure re-evaluation and re-verification index](corrections-2026-10-30-issues-112-123.md) |
| #115 (CAD 查看器) | [Desktop issue 115 CAD viewer — the directory is issue-115-cad-viewer because issue-115/ belongs to the iDeer repo issue of the same number](issue-115-cad-viewer/report.md) |
| #100 (Wiki 双链与邻域导航) | [Desktop issue 100 wiki graph navigation — the directory is issue-100-wiki-navigation because issue-100/ belongs to the iDeer repo issue of the same number](issue-100-wiki-navigation/report.md) |
| #97 (BM25 全文索引与漂移标注) | [the directory is issue-97-bm25-index because issue-97/ belongs to the old installer-acceptance numbering](issue-97-bm25-index/report.md) |
