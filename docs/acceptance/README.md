# Acceptance records

When reviewing issue completion, start with the relevant report below. Reports
bind their results to a candidate and environment; read their coverage limits
before applying an older result to newer code. GitHub issues track discussion
and link to these versioned records.

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
| #96–#104 | [#96](issue-96/report.md), [#97](issue-97/report.md), [#98](issue-98/report.md), [#99](issue-99/report.md), [#100](issue-100/report.md), [#101](issue-101/report.md), [#102](issue-102/report.md), [#103](issue-103/report.md), [#104](issue-104/report.md) |
| #105 | [Report](issue-105/report.md) |
| #106 | [Report](issue-106/report.md) |
| #107 | [Report](issue-107/report.md) |
| #109 | [Report](issue-109/report.md) |
| #110 | [Report](issue-110/report.md) |
| #111 | [Report](issue-111/report.md) |
