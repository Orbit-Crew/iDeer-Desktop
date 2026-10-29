---
id: issue-119-desktop-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 119 Desktop side of the wiki navigation index — links, backlinks, and the association graph through the Server chain
last-verified: 2026-10-27
verified-against: orch/issue-119-wiki-index working tree on top of 5b9f306 (#118 candidate); every acceptance command below was run against the tree exactly as committed
---

# Issue 119 Desktop acceptance

The Desktop candidate lives in the isolated worktree
`G:\code\iDeer-worktrees\issue-112-desktop` (WSL:
`/mnt/g/code/iDeer-worktrees/issue-112-desktop`), branch
`orch/issue-119-wiki-index`, stacked on 5b9f306 (#118). The Server repo
carries the same branch on top of b63c408e; its companion report is
`docs/acceptance/issue-119/report.md` in that repository. No issue closure,
no PR, and no `dist:win` installer are claimed by this report — packaging
stays a recorded-pending step (see Pending).

## Implemented surface

- `local-runtime/core/platform_chat.py`: `DesktopChat.wiki` gains the
  `navigate` action. It GETs the Server's
  `…/knowledge-revisions/{rid}/wiki/navigation` endpoint and projects the
  index through `_wiki_navigation_payload` (+ `_wiki_link_rows`,
  `_wiki_associations_payload`): every page row keeps its honest
  `completed/skipped/failed/not_generated` status, link and backlink rows
  are validated (`CHAT_PROTOCOL_ERROR` otherwise) and carry the target's
  status — a link into a skipped page never looks readable — missing
  targets stay explicit bounded text, and the association graph reuses the
  Server's stored #116 rows with their frozen document binding (filename +
  content hash). Nothing is fabricated into an accessible page; the
  projection is bounded (200 pages / 100 links / 100 missing / 200
  association rows).
- `local-runtime/core/desktop.py`: the `knowledge-wiki` control command
  gate accepts `navigate` in its fixed action set (`view`/`generate`/
  `read`/`navigate`; `read` still requires a well-formed `documentId`,
  navigate carries none) and dispatches to `wiki`; fixed error categories
  still cross the boundary.
- `src/main/runtime.ts`: `RuntimeProcess.knowledgeWiki` accepts
  `navigate` in its action validation (same UUID/kb/revision checks, same
  single-flight and timeout discipline) and resolves the response as a
  `WikiNavigation`.
- `src/shared/desktop.ts`: `WikiLink`, `WikiNavigationPage` (extends
  `WikiPageSummary`), `WikiAssociationSource/Entity/Relation`,
  `WikiAssociations`, `WikiNavigation`; `WikiCommand.action` gains
  `navigate`; the bridge's `knowledgeWiki` return widens accordingly. The
  `desktop:knowledge:wiki` IPC channel is unchanged and stays pinned in
  `test/security.test.ts`.
- `src/renderer/src/components/WikiSection.tsx` (+ `RuntimePanel.tsx`
  wiring): every registered revision offers 导航索引 alongside
  查看Wiki / 生成Wiki. The index renders the aggregate status line
  (成功/失败/跳过), the frozen manifest hash, a partial-warning alert, the
  association-graph summary (status + 生成/失败 counts + 实体/关系 counts +
  one coverage row per document source with its frozen digest and honest
  status), and the page index with per-page title/status, resolved 链接
  and 反链, and 缺失目标 as explicit dead ends
  （未在此冻结版本中登记或生成，不可访问）. A link or backlink whose target is
  completed renders as a button that reuses the existing `read` action —
  page-to-page navigation and the way back to sources walk the same
  Server-guarded read; a non-completed target only names its status and
  never offers a read entry. `runWiki` resets the list, any open page, and
  the navigation index whenever the revision context changes
  (view/generate/navigate), so an older revision's body or index can never
  render beside a newer one.

## Commands and results

Environment: Windows host (win32 10.0.26300 x64); Windows node
(`.tools/node-v22.14.0-win-x64`) for typecheck/vitest; WSL Ubuntu Python
3.13 miniconda for the runtime pytest. All commands run 2026-10-27 against
the committed tree.

| Suite | Result |
| --- | --- |
| `npm run typecheck` | clean, exit 0 |
| `npx vitest run test/wiki.test.tsx` | 11 passed (6 #118 + 5 new navigation) |
| `npx vitest run` (full) | 26 files, 119 passed, exit 0 (baseline 26 files / 114 → +5 new navigation tests; one unrelated bundled-runtime flake under contention passed on rerun, matching the recorded #118 behavior) |
| runtime `pytest tests/test_platform_wiki.py -q` | 9 passed (6 #118 + 3 new navigate) |
| runtime `pytest tests -q` (full) | 461 passed, 11 skipped, exit 0 (109 s; baseline 458 / 11 → +3 new) |
| Server companionship: `test_wiki_navigation.py` 14, `test_knowledge_wiki_navigation_router.py` 5, `unit/knowledge` 391/3skip, full `integration/api` 1415/43skip, `ruff check backend` clean | all green (see Server companion report) |

## Scenario records (T119-01..04)

| Scenario | Ticket ACs | Automated evidence (passed) | Staged / unexecuted remainder |
| --- | --- | --- | --- |
| T119-01 (索引 → P → 链接 → Q → 反链 → 关联图 → 返回来源闭环) | 1, 3, 4 | runtime `test_navigate_projects_index_with_links_backlinks_and_associations` — the navigate action reads exactly the Server's navigation endpoint, never POSTs (read-only derivation), and projects links/backlinks/associations bounded; vitest `renders the navigation index with honest per-page statuses…`, `renders links and backlinks as page-to-page navigation and missing targets as explicit dead ends` — a completed 链接/反链 target renders as a clickable 前往/返回 button reusing the #118 `read` action, and the body renders under the index (`page.revisionId === navigation.revisionId` guard). Server-side closure: companion report T119-01 (`test_owner_navigates_links_backlinks_and_associations` ends by reading the linked target). | Manual three-end pass (index → P → link → Q → backlink → graph → back to source) + screenshots: **unexecuted** (depends on real-model staging from #118's T118-01). |
| T119-02 (B / 收紧范围越权不可见，权限矩阵) | 1, 4 | The renderer only ever names KB/Revision/action — authorization stays the Server's; navigation rides the same IPC channel pinned in `test/security.test.ts` and the same authenticated-only main guard. vitest `validates the wiki command before the owned Runtime` still holds and `accepts the navigate action at the owned Runtime seam…` proves malformed actions are refused before anything reaches the Runtime. Visibility matrix (stranger 404, department navigate, cross-KB revision 404): companion report T119-02. | None beyond the shared real-model staging. |
| T119-03 (Q 缺失 / 部分生成 / 来源不可用明确状态) | 2, 4 | runtime `test_navigation_projection_is_bounded` + `test_malformed_navigation_answers_are_protocol_errors` — invented statuses, a bad aggregate/association status, a non-dict association graph, or a bad manifest hash are protocol errors, never rendered as pages; vitest `renders links and backlinks…` — a link into a skipped page shows （已跳过） with no read entry and a missing target renders 缺失目标：…（未在此冻结版本中登记或生成，不可访问） with no way to open it; `renders the association graph summary with frozen source coverage` shows per-source honest statuses. Server-side honesty proofs: companion report T119-03. | Manual fault-injection UI pass + screenshots: **unexecuted** (staged with real-model credentials). |
| T119-04 (新版本发布后旧 Wiki 版本归属不漂移) | 1, 3 | `runWiki` resets the page list, any open body, and the navigation index whenever the revision context changes (view/generate/navigate), so versions can never mix in one view; every command carries the exact (kbId, revisionId) it was opened with and every rendered row keeps its manifest hash and frozen digests. Server-side two-revision isolation: companion report T119-04. | Manual reopen-the-old-session check on the real UI: **unexecuted** (staged with the real-model environment). |

## Pending / risks

- `npm.cmd run dist:win` packaging and the installed-app startup/exit
  verification: **pending** — not run in this worktree; the installer
  SHA-256 is therefore not recorded here. The ticket's packaging
  requirement stays open until the staged packaging pass.
- Real-LLM and real-three-end manual passes: **unexecuted on model
  credentials**; the contracts above are pinned by the automated suites.
- Real Win7: **unexecuted**, owned by [#131](https://github.com/Orbit-Crew/iDeer/issues/131);
  modern-Windows results are not Win7 results.
- Link targets render by their honest status, so a completed target is
  always clickable, while skipped/failed/missing targets stay
  non-clickable text; page bodies remain bounded at 20000 chars end to end
  and navigation rows are bounded (200 pages / 100 links) end to end.
- `dev-log/` remains an untracked local working directory in this repo
  (ticket copy at `dev-log/ticket-119.md`), exactly as at baseline.

Execution update, 2026-10-29: the prepared driver ran end-to-end (r8–r10,
settling at r10). The 60 s bounded generate, the honest skipped-page record,
the cross-account invisibility and the projection-shape bounds executed for
real; T119-04 asserts the frozen-manifest contract beside the new revision
server-side. The completed-target walk, the presentation legs and the flood
bounds stay staged on the material-consent approval-surface and provider
dependencies. Bindings and sanitized evidence are in
[installed-20261029.md](installed-20261029.md). Win7 remains with #131.
