# Issue #98 two-axis review (before push)

Two parallel review passes over `git diff origin/develop..HEAD` — one against
the repo's documented standards and established idioms, one against the
issue's acceptance criteria — followed by fixes and re-verification. (The
file previously held earlier sessions' reviews (#97/#100); those records live
on in their branches' history, and this file now documents the #98 pass, as
ticket.md documents the #98 ticket.)

# Issue #120 two-axis review (before final commit)

Fixed point: 90e6fbf (the #164 merge completing the integration base; the three
stacked branches were reviewed in their own PRs #162/#163/#164). Diff
`git diff 90e6fbf...HEAD` over commits 14d3fa9 / 6052c4c / d539679, two
independent sub-agents (Standards / Spec) run in parallel.

## Standards axis — findings and dispositions

1. **Workspace error codes were compared against the human message** (fixed,
   必修): the seam mapped `str(exc)` against `WORKSPACE_UNAVAILABLE` /
   `OUTSIDE_ALLOWED_ROOTS` / `PROTECTED_PATH`, but `FileAccessError` stores
   the code on `.code` and `str()` is the lowercased message, so the honest
   `KNOWLEDGE_SEARCH_WORKSPACE_UNAVAILABLE` category was unreachable — an
   unconfirmed workspace answered the generic `KNOWLEDGE_SEARCH_FAILED`.
   The mapping now reads `getattr(exc, "code", "")` (the `category_for`
   precedent), pinned by
   `test_library_search_names_an_unconfirmed_workspace_and_file_boundary_honestly`.
2. **Unused `audit` unpacks in four seam tests** (fixed, nit): renamed to
   `_audit`, matching the sibling file's convention.
3. **`answer_frozen_revision` read `document_layouts` on every answer**
   (fixed, nit): the layouts feed only the literal scan (the BM25 branch
   carries anchors inside its ranked rows), so the read moved into the
   literal branch — the broker hot path no longer pays a full-revision
   layout read it never consumes.
4. **依据不完整 banner understated a fully failed scope** (fixed, nit): the
   KnowledgeGraphSection banners now say 部分或全部所选文档未成功参与, so an
   all-documents-failed scope is not described as "部分".

## Spec axis — findings and dispositions

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

1. **No test drove a successful search through the desktop loop** (fixed,
   应修): the load-bearing `task_id=search_command['id']` threading — the
   traceability the audit commit exists for — was only exercised below the
   dispatch. New `test_desktop_knowledge_search.py` drives `desktop.main()`
   end-to-end: the command passes the wire gate, the reply carries
   `auditTaskId == command id` with real page/table citations, and the
   profile's real `audit.db` row pins the same id, digest, and query digest;
   the refusal path keeps its fixed category on the same loop.
2. **Unresolvable servability silently claimed complete evidence** (fixed,
   nit): when `index.servable_identities` fails, a verified document the
   index cannot serve produces neither a hit nor a structured missing, and
   `evidenceComplete` stayed true. The indexed engine now flags
   `servableUnknown`, and `answer_frozen_revision` refuses the
   complete-evidence claim in that case, pinned by
   `test_unresolvable_servability_never_claims_complete_evidence`.
3. **The durable audit row lacked the credential identity** (fixed, nit):
   the row now carries `actor_id` (user id) plus the origin/device summary
   in `detail`, so AC2 stays queryable from the durable row alone; the
   seam test asserts the row and the absence of the raw query.
4. **No engine test drove truncation** (fixed, nit):
   `test_literal_scan_overflow_marks_truncation_and_incomplete_evidence`
   overflows `MAX_MATCHES`, pins `truncated` and the refused
   `evidenceComplete`, and the visible fallback reason.
5. **Truncation-only incompleteness showed the document-missing banner**
   (fixed, nit): the doc library's 依据不完整 banner now names the cut
   (命中数量达到上限) when nothing is missing, pinned by a UI test.

No hard standards breaches: stdlib-only Python, no new dependencies, one
fixed-category boundary, exact-shape gates with updated security pins
(preload channel list + smoke bridge keys, both sorted), one audit write
point at the seam (fail-closed), physical paths never crossing to the
renderer or the wire, and the merge's union resolutions (channel lists,
bridge keys, controller Pick, pane JSX) all coherent.

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
