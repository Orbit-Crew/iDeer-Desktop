---
id: issue-118-desktop-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 118 Desktop side of the wiki page list, reading surface, progress, and sources through the Server chain
last-verified: 2026-10-27
verified-against: orch/issue-118-auto-wiki working tree on top of 4d4e224 (#117 candidate); every acceptance command below was run against the tree exactly as committed
---

# Issue 118 Desktop acceptance

The Desktop candidate lives in the isolated worktree
`G:\code\iDeer-worktrees\issue-112-desktop` (WSL:
`/mnt/g/code/iDeer-worktrees/issue-112-desktop`), branch
`orch/issue-118-auto-wiki`, stacked on 4d4e224 (#117). The Server repo
carries the same branch on top of 06ec0c23; its companion report is
`docs/acceptance/issue-118/report.md` in that repository. No issue closure,
no PR, and no `dist:win` installer are claimed by this report — packaging
stays a recorded-pending step (see Pending).

## Implemented surface

- `local-runtime/core/platform_chat.py`: `DesktopChat.wiki` gains the three
  actions `view`, `generate`, and `read`. `view`/`generate` project the
  Server's page list through `_wiki_view_payload`: every row is validated
  and bounded (page statuses pinned to
  `completed/skipped/failed/not_generated`), progress counts are carried as
  ints, and a page body never travels with the list. `read` validates the
  requested document id (`_wiki_document_id`, bounded, fixed charset)
  **before** anything is sent, then GETs the Server's per-page endpoint;
  `_wiki_page_payload` projects a body only for a completed page — a skip
  or failure projects as exactly that: its fixed category, never text. The
  device never runs a model, never reads a page from anywhere but the
  Server, and never filters authorization locally.
- `local-runtime/core/desktop.py`: the `knowledge-wiki` control command
  accepts exactly the allowed key sets (`view`/`generate`, or `read` +
  `documentId`, both type-checked and bounded) and dispatches them to
  `wiki`; fixed error categories still cross the boundary.
- `src/main/runtime.ts`: `RuntimeProcess.knowledgeWiki` validates commands
  before the owned Runtime (`KNOWLEDGE_WIKI_KB/REVISION/ACTION/DOCUMENT_INVALID`,
  bounded single-flight `KNOWLEDGE_WIKI_BUSY`/`TIMEOUT`) and forwards on
  the wire. The response path validates per action: the page list needs a
  64-hex manifest hash, known aggregate status, int counts, and a bounded
  pages array; a page read needs a document id and a known page status, and
  a body only passes when the status is `completed` — otherwise
  `KNOWLEDGE_WIKI_FAILED`.
- `src/shared/desktop.ts`: `WikiCommand`, `WikiPageSummary`, `WikiView`,
  `WikiPage`; the bridge gains `knowledgeWiki`.
- `src/preload/index.ts` + `src/main/index.ts`: the new
  `desktop:knowledge:wiki` invoke channel, main-frame-checked and
  authenticated-only (`KNOWLEDGE_WIKI_UNAUTHENTICATED`), pinned in
  `test/security.test.ts`.
- `src/renderer/src/components/WikiSection.tsx` (+ `RuntimePanel.tsx`
  wiring): the Wiki entry lists the account's registered revisions with
  查看Wiki / 生成Wiki actions; the view renders progress (成功/失败/跳过
  counts), the manifest hash, a partial-warning alert, and the page list
  with per-page title/status (跳过 with its fixed category, never a read
  entry) and the frozen source filename + digest on every page; 阅读此页
  fetches one page and renders its body next to its source digest.
  `runWiki` resets the list and any open page on view/generate, so an older
  revision's body can never render beside a newer list.

## Commands and results

Environment: Windows host (win32 10.0.26300 x64); Windows node
(`.tools/node-v22.14.0-win-x64`) for typecheck/vitest; WSL Ubuntu Python
3.13 miniconda for the runtime pytest. All commands run 2026-10-27 against
the committed tree.

| Suite | Result |
| --- | --- |
| `npm run typecheck` | clean, exit 0 |
| `npx vitest run test/wiki.test.tsx test/security.test.ts` | 7 passed (6 new wiki + 1 updated security pin) |
| `npx vitest run` (full) | 26 files, 114 passed, exit 0 (baseline 25 files / 108 → +6 new wiki tests; no flakes) |
| runtime `pytest tests/test_platform_wiki.py -q` | 6 passed |
| runtime `pytest tests -q` (full) | 458 passed, 11 skipped, exit 0 (111 s; baseline 452 / 11 → +6 new) |
| Server companionship: `test_wiki_generation.py` 36, `test_knowledge_wiki_router.py` 7, adjacent consent/graph/facade 29, `unit/knowledge` 377/3skip, full `integration/api` 1410/43skip, `ruff check backend` clean | all green (see Server companion report) |

## Scenario records (T118-01..04)

| Scenario | Ticket ACs | Automated evidence (passed) | Staged / unexecuted remainder |
| --- | --- | --- | --- |
| T118-01 (generate against an approved Revision; Server orchestration, device material/upload scope) | 1, 4 | runtime `test_generate_posts_then_reads_the_list` — the device posts once to the Server's `POST …/wiki` endpoint and reads the list back; it never touches material itself and never uploads a library. Server-side orchestration/binding: `test_generation_is_server_orchestrated_and_requests_one_document_at_a_time` + `test_provider_material_comes_from_platform_storage_without_device_dispatch` (companion report T118-01); device consent legs are the unchanged `test_knowledge_material.py`. | Real cross-repo run with real model credentials: **unexecuted** (no model credentials). Staged: both repos' suites plus one live generation against a paired Desktop. |
| T118-02 (Desktop wiki list → page body → source; progress/skips/partial visible) | 2, 4 | vitest `shows the page list with progress and frozen sources, never bodies` (成功/失败/跳过 counts, manifest hash, per-page digest, no body in the list), `reads a completed page with its body and source digest`, `keeps skips and partial failures visible…` (跳过 1 with `GRAPH_CONTENT_DRIFTED`, no read entry for the skipped page), `projects a failed or ungenerated page read as a warning without any body`; runtime `test_view_projects_bounded_page_list_with_progress_and_sources`, `test_read_fetches_one_page_body_with_its_source`, `test_skipped_page_projects_its_category_never_text`. Server-side honesty: companion report T118-02. | Manual reading pass on the real three-end UI with model-generated pages + screenshots: **unexecuted** (depends on T118-01's real-model staging). |
| T118-03 (retry after partial failure; new Revision; reopen old wiki) | 3, 4 | `runWiki` resets the page list and any open page whenever the revision context changes (view/generate), so versions can never mix in one view; every command carries the exact (kbId, revisionId) it was opened with. Server-side frozen-basis/retry/isolation proofs: companion report T118-03 (manifest byte-identical after retry; R1 wiki ≠ R2 wiki over HTTP). | Manual reopen-the-old-session check on the real UI: **unexecuted** (staged with the real-model environment). |
| T118-04 (unauthorized pages invisible; out-of-scope reads/generation refused) | 1, 3 | vitest `validates the wiki command before the owned Runtime` — malformed kb/revision/action/document commands never reach the Runtime; runtime `test_read_requires_a_bounded_document_id` — refused commands issue no HTTP at all; the renderer only names KB/Revision/action, authorization stays the Server's. Visibility matrix and out-of-manifest 404s: companion report T118-04. | None beyond the shared real-model staging. |

## Pending / risks

- `npm.cmd run dist:win` packaging and the installed-app startup/exit
  verification: **pending** — not run in this worktree; the installer
  SHA-256 is therefore not recorded here. The ticket's packaging
  requirement stays open until the staged packaging pass.
- Real-LLM and real-three-end manual passes: **unexecuted on model
  credentials**; the contracts above are pinned by the automated suites.
- Real Win7: **unexecuted**, owned by [#131](https://github.com/Orbit-Crew/iDeer/issues/131);
  modern-Windows results are not Win7 results.
- The wiki reading surface renders generated Markdown as pre-wrapped text
  (no HTML rendering), so model output is display-only and cannot execute
  anything; page bodies are bounded at 20000 chars end to end.
- `dev-log/` remains an untracked local working directory in this repo
  (ticket copy at `dev-log/ticket-118.md`), exactly as at baseline.
