---
id: issue-116-desktop-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 116 Desktop side of the controlled knowledge-graph entry with source visibility
last-verified: 2026-10-27
verified-against: orch/issue-116-controlled-graph working tree on top of 465c02e (#114 Desktop candidate); every acceptance command below was run against the tree exactly as committed
---

# Issue 116 Desktop acceptance

The Desktop candidate is the isolated worktree
`G:\code\iDeer-worktrees\issue-112-desktop`, branch
`orch/issue-116-controlled-graph`, starting at 465c02e (the #114 Desktop
candidate). The Server repo carries the same branch name at d862a1ea; its
companion report is `docs/acceptance/issue-116/report.md` in that
repository. No issue closure, no PR, and no dist:win packaging run are
claimed by this report (packaging stays a pending step).

## Implemented surface

- `local-runtime/core/knowledge_material.py` (new): the device side of the
  Server-orchestrated generation. The material task carries the frozen
  manifest identity and **exactly one** document — a multi-document request
  is refused outright (`BULK_REQUEST_REFUSED`), so this device can never be
  a bulk library source. Only a revision this identity registered on this
  device is ever answered (`KNOWLEDGE_MATERIAL_REVISION_UNKNOWN`); the
  document is re-validated content-addressed at read time, and a drifted,
  missing, oversized (512 KiB bound, mirrored server-side), or non-text
  document is a structured missing reason instead of substituted content.
  Physical paths never leave the device.
- `local-runtime/core/file_service.py`: `local.knowledge.material` joins
  the announced workspace capabilities and reuses the #113
  registry-bound workspace boundary.
- `local-runtime/core/policy.py` / `transport.py`: material is a LEVEL_1
  capability — the wire answer to an unconfirmed task is a consent request
  carrying no text; the signed receipt records the approval
  (`consent_decision='allow_once'`).
- `local-runtime/core/knowledge_material.locate_frozen_document`: the
  "locate source" leg resolves the graph's source document against the
  confirmed workspace by (filename, frozen digest) and answers with the
  workspace logical path — a local display fact that never reaches the
  Server.
- `local-runtime/core/platform_chat.py`: `knowledge_graph(view/generate/
  locate)` — view/generate read exactly what the Server states (bounded,
  validated projection `_graph_view_payload`; a malformed answer is
  `CHAT_PROTOCOL_ERROR`, never an invented view), and locate first checks
  the source reference against the Server view, then the local workspace.
- `local-runtime/core/desktop.py`: the `knowledge-graph` control command
  (exact key-set validation, fixed-category error mapping).
- `src/main/runtime.ts`: `knowledgeGraph(command)` with strict request
  validation (UUID KB/revision, action whitelist, locate document id), a
  dedicated request map, pending-request rejection on runtime exit, and
  strict response validation for both the view and the locate shapes.
- `src/main/index.ts` / `src/preload/index.ts` / `src/shared/desktop.ts`:
  one new reviewed IPC capability `desktop:knowledge:graph` behind the
  authenticated-session check;
  `test/security.test.ts` enumerates it explicitly.
- `src/renderer/src/components/KnowledgeGraphSection.tsx` (new) mounted in
  `RuntimePanel.tsx`: the 图谱入口 lists exactly the current account's
  registered revisions (failed imports are never offered), renders
  entities, the representative relation, and per-document sources bound to
  the frozen revision (manifest hash and document digests shown), surfaces
  partial failures as partial (`部分文档生成失败：缺失的关系不代表完整图谱`)
  with per-source error codes, and locates an authorized source back to its
  workspace path. Cross-account/scope invisibility is structural: rows come
  from the binding-scoped local registry and the Server's own visibility.

## Commands and results

Windows node: `.tools/node-v22.14.0-win-x64`; runtime Python via WSL
miniconda (documented runner). All commands run 2026-10-27 against the
committed tree.

| Suite | Result |
| --- | --- |
| `npm run typecheck` (tsc node + web) | exit 0 |
| `npx vitest run` (full) | 25 files, 103 passed, exit 0 (recorded baseline 24 files / 98 tests; +1 file, +5 tests) |
| `npx vitest run test/knowledge-graph.test.tsx test/security.test.ts` | 6 passed |
| `pytest local-runtime/tests` (full, from `local-runtime/`) | 447 passed, 11 skipped, exit 0 (recorded baseline 429 + 11 → +12 material tests, +6 graph-entry tests) |
| `pytest tests/test_knowledge_material.py tests/test_platform_knowledge_graph.py` | 12 passed + 6 passed |
| Server focused suites | see companion report (unit graph 27, router 6, consent gate 6) |

Key test-to-AC bindings: `test_payload_validation_requires_exactly_one_document`
+ `test_signed_material_task_asks_for_local_consent_before_any_text` (AC1 —
authorized material only, no bulk, no text before local approval);
`test_frozen_match_returns_verified_text`, `test_view_projects_bounded_server_facts_without_generation`
(AC2 — facts bound to the frozen revision, display never invents);
`test/knowledge-graph.test.tsx` "offers no graph entry for other accounts"
(AC3 — cross-account invisible; the entry exists in the real UI, not only
as an API/script); `test_locate_reports_drift_instead_of_a_stale_path`,
`test_drifted_file_reports_content_drift`, and the panel's partial-failure
render (AC2/AC4 — honest failures).

## Scenario records (T116-01..04)

| Scenario | Ticket ACs | Automated evidence (passed) | Staged / unexecuted remainder |
| --- | --- | --- | --- |
| T116-01 | 1, 2, 4 | Device legs: material requests are single-document and consent-gated before any text leaves (`test_signed_material_task_asks_for_local_consent_before_any_text`), unknown/foreign revisions refused. Server orchestration and dispatch shape: companion report. | Real cross-repo run with real model credentials: **unexecuted** (no model credentials; also requires the staged live generation). |
| T116-02 | 2, 3, 4 | `test/knowledge-graph.test.tsx` — the panel renders entities, the representative 甲零件—[属于]→乙组件 relation with its source document, digests, and the locate button; `test_platform_knowledge_graph.py::test_locate_resolves_the_source_in_the_workspace` resolves the source in a real confirmed workspace and keeps the path local. | Manual usability pass (click-through with screenshots, real model graphs): **unexecuted**, staged with the Server report's T116-01 real-model run. |
| T116-03 | 2, 3 | The entry lists only the current account's registered revisions; failed imports and empty registries offer no entry (`offers no graph entry for other accounts or unregistered revisions`); Server visibility matrix (companion report) is fully green. | Manual matrix re-check on the live deployment folds into T116-02's staged pass. |
| T116-04 | 2, 4 | Partial generation renders as partial with per-source fixed error codes and the surviving source still readable (`keeps partial failures visible instead of a complete graph`); drifted sources report `content_drift` honestly (`test_locate_reports_drift_instead_of_a_stale_path`). | Page re-open persistence check on the real UI: **unexecuted** (staged with T116-02). |

## Pending / risks

- dist:win packaging, install/start/exit verification: **not run** in this
  worktree — recorded as the pending packaging step for the candidate.
- Real-LLM-condition scenarios (T116-01 live leg, T116-02/T116-04 manual
  passes) are **unexecuted on model credentials**; the UI contract they
  depend on is pinned by the automated suites above.
- Real Win7: **unexecuted**, owned by
  [#131](https://github.com/Orbit-Crew/iDeer/issues/131); modern-Windows
  results here are not Win7 results.
- The Desktop graph entry is the only new renderer surface; no chat/runtime
  behavior changed beyond the added section, and the security boundary test
  pins the single new IPC channel.
