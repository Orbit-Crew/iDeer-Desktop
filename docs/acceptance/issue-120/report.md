---
id: issue-120-desktop-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 120 Desktop side of the complete Skill package preview import — Markdown/ZIP/directory preview, explicit confirm to a private platform draft, and the published version copy
last-verified: 2026-10-27
verified-against: orch/issue-120-skill-import working tree on top of 0fc854d (#119 candidate); every acceptance command below was run against the tree exactly as committed
---

# Issue 120 Desktop acceptance

The Desktop candidate lives in the isolated worktree
`G:\code\iDeer-worktrees\issue-112-desktop` (WSL:
`/mnt/g/code/iDeer-worktrees/issue-112-desktop`), branch
`orch/issue-120-skill-import`, stacked on 0fc854d (#119). The Server repo
carries the same branch on top of 01374778; its companion report is
`docs/acceptance/issue-120/report.md` in that repository. No issue closure,
no PR, and no `dist:win` installer are claimed by this report — packaging
stays a recorded-pending step (see Pending).

## Implemented surface

- `local-runtime/core/skill_import.py` (new): the device-side package reader
  and the binding-scoped `SkillImportRegistry`. `read_package` accepts one
  user-picked Markdown file, ZIP archive, or directory and refuses
  everything illegal before a single byte leaves the machine — path
  traversal/absolute/backslash members, ZIP symlink entries, junctioned or
  symlinked selections and ancestors, unscanned executables (same suffix
  set as the platform), oversized entries/files/packages, missing
  `SKILL.md`, and non-front-matter markdown — each with a fixed category
  (`SKILL_IMPORT_*`). The preview projects the upload scope: body (bounded
  20000), per-file path/role/bytes/SHA-256 (bounded 200 files), counts, and
  the canonical package hash (sorted relative POSIX paths, length-prefixed
  — the platform's own `_hash_directory` algorithm, so one hash names the
  same bytes on both sides). Markdown wraps as `SKILL.md`; a directory is
  zipped in memory with plain 0644 members. The registry keeps only
  identity/display facts (never package content), rows are
  profile-binding-scoped, statuses are `imported`/`published`/`failed`
  with the real fixed error category, and identical failed attempts
  collapse to the first fact.
- `local-runtime/core/platform_chat.py`: `import_skill_package` previews
  fully offline (no network call, no registry row); the confirmed flow
  re-reads the exact bytes, POSTs them as multipart (`archive` file part +
  `origin`/`expected_package_hash` fields — the Server endpoints' exact
  contract) to `/api/resources/import/skill/preview` and refuses on any
  hash disagreement (`SKILL_IMPORT_HASH_MISMATCH`) before
  `/api/resources/import/skill/confirm` may create anything; the reply's
  draft hash must equal the device hash (`CHAT_PROTOCOL_ERROR` otherwise).
  `publish_skill` rides the existing platform publish endpoint with
  `expected_draft_revision` and records the returned immutable version
  copy. Every failure is recorded with its real fixed category and never
  impersonates a draft or version.
- `local-runtime/core/desktop.py`: the `skills` control command gate
  (exact key sets for `import`/`publish`, kind/paths/confirmed and
  resourceId/expectedDraftRevision shape checks) and the dispatch that
  lets only fixed categories cross the boundary
  (`CHAT_*`/`SKILL_IMPORT_*`/`SKILL_PUBLISH_*`, else
  `SKILL_IMPORT_FAILED`); the status snapshot carries the binding-scoped
  `skillImports` view (≤20) and `skillImportStorageError`.
- `src/main/runtime.ts`: `importSkill`/`publishSkill` with command
  validation before the owned Runtime (`SKILL_COMMAND_INVALID`), one
  in-flight import and publish each, bounded timeouts, and response
  shapes resolved only against their exact contract (hash-shaped package
  hash, UUID resourceId, private destination on previews, ≥1
  revision/version). The status parse projects `skillImports` rows
  honestly — a failed row carries no hash to impersonate.
- `src/main/index.ts`: the `desktop:skills` IPC handler. Package picking,
  the device-side preview, and both confirmations stay in the trusted
  main process: file/directory dialogs per kind, then a native
  confirmation dialog that shows the body excerpt (bounded 600 chars),
  the full upload scope (each file with its role and size), and the
  package fingerprint before anything uploads; cancel maps to
  `SKILL_IMPORT_CANCELED`/`SKILL_PUBLISH_CANCELED` and uploads nothing.
  The publish confirmation explains that the platform's own
  validate/publish flow creates the immutable version copy and that Runs
  pinned to a version are unaffected.
- `src/preload/index.ts` + `src/shared/desktop.ts`: the `skills` bridge
  entry (one new IPC channel `desktop:skills`, pinned in
  `test/security.test.ts`) and the `SkillImportPreview` (with
  `bodyExcerpt`), `SkillImportOutcome`, `SkillPublishOutcome`,
  `SkillPackageFileView`, `SkillImportView` types.
- `src/renderer/src/components/SkillSection.tsx` (+ `RuntimePanel.tsx`
  wiring): three explicit import entries (Markdown/ZIP/目录), honest
  record states — 私有草稿 R{n} with its copyable package fingerprint,
  平台版本副本 V{n} with its fingerprint, failures as their fixed
  category with no hash — and the 发布此草稿为版本副本… handle that
  reuses the platform's own draft/publish flow. `runSkill` refreshes the
  panel after a resolved command so the new record is visible.

## Commands and results

Environment: Windows host (win32 10.0.26300 x64); Windows node
(`.tools/node-v22.14.0-win-x64`) for typecheck/vitest; WSL Ubuntu Python
3.13 miniconda for the runtime pytest; bundled runtime rebuilt via
`python3.12 scripts/prepare-runtime.py` before the bundled-runtime leg.
All commands run 2026-10-27 against the working tree at this candidate.

| Suite | Result |
| --- | --- |
| `npm run typecheck` | clean, exit 0 |
| `npx vitest run test/skills.test.tsx test/security.test.ts` | 4 passed (3 new + security regression with the pinned `desktop:skills` channel) |
| `npx vitest run` (full) | 27 files, 122 passed, exit 0 (baseline 26 files / 119 → +3 new skill-bridge tests; one unrelated `receipt-history` contention flake passed on rerun and in the final clean full run, matching the recorded #118/#119 flake behavior) |
| runtime `pytest tests/test_skill_import.py -q` (from `local-runtime/`) | 10 passed |
| runtime `pytest tests -q` (full) | 471 passed, 11 skipped, exit 0 (119 s; baseline 461 / 11 → +10 new device import tests) |
| Server companionship: `test_resources_api_skill_import.py` 14, full `integration/api` 1415/43skip, `ruff check backend` clean | all green (see Server companion report) |

## Scenario records (T120-01..04)

| Scenario | Ticket ACs | Automated evidence (passed) | Staged / unexecuted remainder |
| --- | --- | --- | --- |
| T120-01 (三种包型预览 + 取消不上传 + 确认后 private 草稿 + 既有校验/发布) | 1, 4 | runtime `test_preview_states_upload_scope_and_uploads_nothing` (parametrized markdown/zip/directory: body excerpt, per-file roles/hashes, package hash, `destination={resourceType: skill, visibility: private}`, zero network records, zero registry rows) and `test_confirmed_import_binds_hash_and_lands_private_draft` (preview+confirm multipart contract with the `archive` part, exact bytes re-sent, private draft handle + hash recorded); vitest `renders the import surface with honest record states and the publish handle`. Server-side preview-persists-nothing and confirm-to-private-draft: companion report T120-01. | Manual UI pass (native pick/preview/cancel/confirm dialogs + screenshots): **unexecuted**, staged — needs the packaged app and an authenticated platform account. |
| T120-02 (内置只读 + 修改产生新草稿/版本 + 本地缓存编辑不能冒充平台 hash) | 2, 3 | runtime `test_local_edit_cannot_impersonate_the_platform_version` (edited local file drifts the hash; the platform refuses a second draft for the owned slug → `CHAT_CONFLICT`, recorded failed) and `test_publish_records_the_platform_version_copy` (publish yields the immutable version copy with its own hash); vitest renders the published row as 平台版本副本 V{n} distinct from the draft. Server-side built-in read-only + fork-to-copy + V2-on-new-draft: companion report T120-02. | Manual built-in readonly UI pass: **unexecuted**, staged with the real platform account. |
| T120-03 (非法路径/损坏/hash 不符/越权明确失败不执行) | 3, 4 | runtime `test_illegal_package_content_is_refused_before_any_upload` (traversal, absolute, ZIP symlink entry, `.sh` executable, missing SKILL.md, missing front-matter, vanished selection — each its fixed category, zero uploads, honest failed records), `test_server_hash_drift_refuses_confirm` (platform preview disagreeing with the device hash refuses before any confirm), `test_unauthenticated_confirm_is_refused_and_recorded`; vitest `validates the package command before the owned Runtime` + the bundled-runtime unauthenticated refusal. Server-side 400s for traversal/absolute/symlink/broken ZIP/unsupported origin, hash-mismatch confirm refusal, and cross-account 404 isolation: companion report T120-03. | Manual fault-injection UI pass: **unexecuted**, staged. |
| T120-04 (Run 冻结 V1，发布 V2 后原 Run 保持 V1、新 Run 用 V2) | 2, 3, 4 | Server-side `test_confirmed_draft_publishes_through_existing_flow_and_keeps_run_frozen` is the owning evidence: the run snapshot freezes version+content_hash at enqueue, V2 lands via a new draft, `get_published_content(version=1)` still returns the frozen hash, `create_run_skill_view` materializes the frozen bytes and raises on a tampered hash. The Desktop leg is `test_publish_records_the_platform_version_copy` (the device records exactly the platform's version copy, draft handle stays the source of truth). | Real cross-repo Run execution (actual Run continuing on V1 while a new Run picks V2): **unexecuted**, staged — needs the real-model Run environment. |

## Pending / risks

- `npm.cmd run dist:win` packaging and the installed-app startup/exit
  verification: **pending** — not run in this worktree; the installer
  SHA-256 is therefore not recorded here. The ticket's packaging
  requirement stays open until the staged packaging pass.
- Manual UI legs (native dialogs, cancel paths, screenshots) and the real
  cross-repo Run leg: **unexecuted**, staged with the real platform/model
  environment; the contracts above are pinned by the automated suites.
- Real Win7: **unexecuted**, owned by [#131](https://github.com/Orbit-Crew/iDeer/issues/131);
  modern-Windows results are not Win7 results.
- The confirmed upload posts the package bytes twice (server preview +
  confirm). The second POST is what lets the Server re-validate the exact
  bytes under the confirmed hash; the duplication is bounded by the same
  100 MB archive cap as every other resource upload.
- `dev-log/` remains an untracked local working directory in this repo
  (ticket copy at `dev-log/ticket-120.md`), exactly as at baseline.
