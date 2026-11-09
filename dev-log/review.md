# Issue #120 two-axis review (before final commit)

Fixed point: 90e6fbf (the #164 merge completing the integration base; the three
stacked branches were reviewed in their own PRs #162/#163/#164). Diff
`git diff 90e6fbf...HEAD` over commits 14d3fa9 / 6052c4c / d539679, two
independent sub-agents (Standards / Spec) run in parallel.

## Standards

No hard violations of documented standards. Root AGENTS.md storage/env rules
respected; `verify:matrix` routes through `scripts/project-env.cjs` like every
sibling; validator/test/doc match the `verify-capability-ledger.cjs` family
patterns; ledger discipline (未记录⇒零证据, 不适用 reservation, 工单状态不是证据)
enforced and stated. Six judgement-call findings:

1. **Duplicated helpers (Duplicated Code)** — `isCalendarDate`,
   `isRepositoryRelativePath`, `exactKeys`, `checkEvidence`, `DATE`,
   `CONTROL_CHARS` copied verbatim from `verify-capability-ledger.cjs`.
   **Deferred with rationale**: extracting a `scripts/lib/` shared module would
   modify `verify-capability-ledger.cjs`, an artifact of open PR #164 under
   another session's review — exactly what the stack discipline forbids
   touching. Recorded as follow-up once #162/#163/#164 merge.
2. **usableNote comment/code mismatch** — bounds were enforced only on
   不适用 and divergence notes. **Fixed**: every non-null note is now bounded
   and single-line (uniform check at cell entry), with a regression test.
3. **Row-blind status finding** — status violations omitted the issue label.
   **Fixed**: `issue <n> <system> status must be one of …`.
4. **Ignored exactKeys return** for `systems.<id>` metadata produced noise
   follow-ups. **Fixed**: early `continue` when the key check fails.
5. **Closed-vocabulary gaps** — `COMMAND_WHITELIST` had no package.json
   cross-check; `SCENARIO_RE` was shape-only (T131-99 would pass).
   **Fixed both**: the CLI now fails on whitelist/script drift, the test file
   statically asserts lockstep, and scenario refs must be real
   T131-01..08 / W7-01..08 ids (negative tests for T131-998 and shape-valid
   T131-09). Extending the sets requires the same change that cites the new
   scenario.
6. **Minor** — 20+ `JSON.parse(JSON.stringify(...))` clones kept (readable,
   matches test intent; sibling's fresh-fixture idiom is stylistic);
   `modernAccepted`/`win7Accepted` now count 能力 rows only (governance can
   no longer inflate the 已验收 story, test updated); duplicate note message
   removed by fix 2.

## Spec

Data sanity all passed (sub-agent cross-checked programmatically):
zero modernWindows status/evidence divergence from the ledger candidate layer;
win7 46/46 未执行 with empty evidence — no fabricated results; the lone 不适用
is governance p6-48 with a reason note; all evidence paths and automated refs
exist on disk; every scenario anchor is a real #131 / W7 id;
retirement-conditions.md records ①未达成 / ②③未开始 and never forges
confirmations; AC checkboxes stay unchecked in dev-log/ticket.md.

- AC2 (现代 Windows 全量验收完成) and AC3 (Win7 真机专项) are partial /
  unexecuted — disclosed exactly as
  [the acceptance report](../docs/acceptance/issue-120-win7-matrix/report.md)
  scopes them; execution is left to candidate rounds and the #131 special.
- 48 rows vs the spec's "46 项能力": ledger-driven superset (46 能力 + 2 治理),
  disclosed, not silent re-scoping.
- Scenario fabrication gap — same as Standards 5b, fixed there.

Standards: 0 hard violations, 6 judgement calls (4 fixed, 1 deferred with
written rationale, 1 partially stylistic accepted). Spec: 1 validator gap
fixed; AC2/AC3 openness matches the report's honest scoping; 0 unresolved.
