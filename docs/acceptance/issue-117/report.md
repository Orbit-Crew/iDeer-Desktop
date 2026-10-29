---
id: issue-117-desktop-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 117 Desktop side of scoped graph QA and relation retrieval through the Server chain
last-verified: 2026-10-27
verified-against: orch/issue-117-graph-qa working tree on top of 6f496dd (#116 candidate); every acceptance command below was run against the tree exactly as committed
---

# Issue 117 Desktop acceptance

The Desktop candidate lives in the isolated worktree
`G:\code\iDeer-worktrees\issue-112-desktop` (WSL:
`/mnt/g/code/iDeer-worktrees/issue-112-desktop`), branch
`orch/issue-117-graph-qa`, stacked on 6f496dd (#116). The Server repo
carries the same branch on top of f60ce1c9; its companion report is
`docs/acceptance/issue-117/report.md` in that repository. No issue closure,
no PR, and no `dist:win` installer are claimed by this report — packaging
stays a recorded-pending step (see Pending).

## Implemented surface

- `local-runtime/core/platform_chat.py`: `DesktopChat.knowledge_graph`
  gains the scoped actions `search` and `ask`. Both validate the selected
  frozen-document scope (`_scoped_document_ids`: 1..50 identity-safe ids,
  deduplicated) and the bounded text (search ≤512, ask ≤4000,
  non-empty) **before** anything is sent, then post once to the Server's
  scoped endpoints `POST /api/resources/{kb}/knowledge-revisions/{rid}/graph/query`
  or `/graph/ask` with `{query|question, document_ids}`. Answers are
  projected by `_graph_scope_payload`: every row is validated and bounded,
  anything the platform did not state is dropped rather than invented, and
  a refused ask is projected as exactly that — `answerAvailable: false`,
  empty answer text, per-document fixed categories in `scope`. The device
  never runs a model, never queries the platform graph through any other
  channel, and never filters authorization locally: scope and permission
  decisions are the Server's.
- `local-runtime/core/desktop.py`: the `knowledge-graph` control command
  accepts exactly the new `documentIds` + `query` key set for
  `search`/`ask` (bounded, type-checked) and dispatches them to
  `knowledge_graph`; fixed error categories still cross the boundary.
- `src/main/runtime.ts`: `RuntimeProcess.knowledgeGraph` validates scoped
  commands before the owned Runtime (`KNOWLEDGE_GRAPH_SCOPE_INVALID` for a
  missing/malformed document-id list, `KNOWLEDGE_GRAPH_QUERY_INVALID` for
  empty/overlong text) and forwards `documentIds`/`query` on the wire. The
  response path branches per action: locate answers keep their local-only
  path projection, view/generate keep the #116 projection, and scoped
  results are validated (64-hex manifest hash, known status, scope array;
  ask requires real answer text only when `answerAvailable`) before the
  bounded projection reaches the renderer.
- `src/shared/desktop.ts`: `KnowledgeGraphCommand` gains
  `documentIds`/`query` and the `search`/`ask` actions; new
  `KnowledgeGraphScopeRow` / `KnowledgeGraphScopedEntity` /
  `KnowledgeGraphScopedRelation` / `KnowledgeGraphQueryResult` /
  `KnowledgeGraphAskResult` types; the bridge signature covers all four
  outcomes.
- `src/renderer/src/components/KnowledgeGraphSection.tsx` (+
  `RuntimePanel.tsx` wiring): the graph entry gains a 问答范围 block — one
  checked checkbox per frozen source (`selectedScope`: everything stays
  selected unless explicitly unchecked, so narrowing only ever shrinks the
  Server-visible scope), a live scope summary, a bounded search input with
  a 检索 button, and a bounded question with a 范围问答 button, both
  disabled without a non-empty text and at least one selected document.
  Scoped retrieval results render with 来源 filename + frozen digest per
  row; the scoped answer renders next to its per-document sources; a
  refusal renders the explicit warning plus the failed documents' fixed
  categories and never an answer. The graph view stays mounted around
  search/ask so the selected scope stays visible next to its results;
  view/generate reset the scope and both result sections.

## Commands and results

Environment: Windows host (win32 10.0.26300 x64); Windows node
(`.tools/node-v22.14.0-win-x64`) for typecheck/vitest; WSL Ubuntu Python
3.13 miniconda for the runtime pytest. All commands run 2026-10-27 against
the committed tree.

| Suite | Result |
| --- | --- |
| `npm run typecheck` | clean, exit 0 |
| `npx vitest run test/knowledge-graph.test.tsx` | 10 passed (5 #116 + 5 new #117) |
| `npx vitest run` (full) | 25 files, 108 passed, exit 0 (one bundled-runtime flake on the first pass cleared on the documented single rerun; baseline 103 + 5 new) |
| runtime `pytest tests/test_platform_knowledge_graph.py -q` | 11 passed (6 #116 + 5 new) |
| runtime `pytest tests -q` (full) | 452 passed, 11 skipped, exit 0 (95 s; baseline 447 / 11 → +5 new) |
| Server companionship: `test_graph_query.py` 15, `test_knowledge_graph_query_router.py` 6, integration graph+consent 18, `unit/knowledge` 341/3skip, `ruff check backend` clean | all green (see Server companion report) |

## Scenario records (T117-01..04)

| Scenario | Ticket ACs | Automated evidence (passed) | Staged / unexecuted remainder |
| --- | --- | --- | --- |
| T117-01 (select X, query/ask inside X, widen to X/Y) | 1, 2, 4 | vitest `narrows the question scope by unchecking sources…` — `selectedScope` narrows only by explicit uncheck, the default renders every source checked with the live scope summary, and the unchecked state reads 未选文档; `shows scoped retrieval results with their frozen document sources` and `shows the scoped answer next to the sources it was built from` render the sourced rows. Device: `test_search_posts_the_selected_scope_and_projects_sourced_rows` / `test_ask_posts_the_question_and_projects_answer_with_scope` pin the exact POST body `{query, document_ids}` / `{question, document_ids}` and the bounded camelCase projection. Server-side scope/narrowing/widening semantics: companion report T117-01. | Manual UI pass on the real three ends with a real model: **unexecuted** (no model credentials). |
| T117-02 (bypass UI: unselected/unauthorized submission; no local model) | 1, 3, 4 | vitest `validates the scoped command before the owned Runtime` — bad scope/query never reaches the Runtime process; device `test_scoped_actions_require_a_bounded_scope_and_query` — refused commands issue no HTTP at all; the scoped actions post only to the Server's scoped endpoints (single-POST assertions), and no device code path invokes a model — answers come only from the Server's `run_oneshot_llm`. Unauthorized KB / foreign-document refusal and the visibility matrix are the Server's automated evidence (companion report T117-02). | None beyond the shared real-model staging. |
| T117-03 (missing material / partial failure must not answer) | 2, 4 | device `test_ask_refusal_is_projected_without_an_answer` — the structured refusal (`GRAPH_CONTENT_DRIFTED` per document, no answer) is the display fact; vitest `renders a refused scoped ask as an explicit failure without an answer` — the warning plus failed-source rows render and the answer text does not. Server-side fault matrix (drift, offline device, model failures, overlong answers, not-generated coverage): companion report T117-03. | Live-device fault injection: **unexecuted**; the deterministic injections cover the same fixed categories. |
| T117-04 (new Revision after the Run; original sources frozen) | 1, 2, 4 | The Desktop view is bound to the exact (kbId, revisionId) the user opened: search/ask always post that revision's id, and view/generate reset the scope so a new revision can never be silently mixed into an opened scope (RuntimePanel `runGraph`). Server-side byte-stability before/after a newer revision: companion report T117-04. | Manual reopen-the-session check on the real UI: **unexecuted** (staged with the real-model environment). |

## Pending / risks

- `npm.cmd run dist:win` packaging and the installed-app startup/exit
  verification: **pending** — not run in this worktree; the installer
  SHA-256 is therefore not recorded here. The ticket's packaging
  requirement stays open until the staged packaging pass.
- Real-LLM and real-three-end manual passes: **unexecuted on model
  credentials**; the contracts above are pinned by the automated suites.
- Real Win7: **unexecuted**, owned by [#131](https://github.com/Orbit-Crew/iDeer/issues/131);
  modern-Windows results are not Win7 results.
- The scoped answer is displayed in the graph entry (same RuntimePanel
  session surface as the platform chat) with its verifiable sources; chat
  threads themselves remain Server-owned history and scoped QA does not
  fabricate synthetic chat messages.

Execution update, 2026-10-29: the prepared driver ran end-to-end (r23) with
the real external model. T117-01/02/04 passed fully; T117-03 passed its four
executable cases and stages the structured per-document refusal display, the
gapped-generation category and the drift presentation on the #116
material-consent approval-surface dependency. Bindings and sanitized evidence
are in [installed-20261029.md](installed-20261029.md). Win7 remains with #131.
