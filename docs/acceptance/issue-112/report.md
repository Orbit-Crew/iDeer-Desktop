---
id: issue-112-desktop-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 112 Desktop side of explicit local knowledge import to platform Revision registration
last-verified: 2026-10-27
verified-against: orch/issue-112-knowledge-import based on 78731f0; candidate is the branch tip of the same tree this evidence was produced from
---

# Issue 112 Desktop acceptance

The Desktop candidate is the isolated worktree
`G:\code\iDeer-worktrees\issue-112-desktop`, branch
`orch/issue-112-knowledge-import`, base 78731f0. The Server repo carries the
same branch name and starts at d37d9723; its companion report is
`docs/acceptance/issue-112/report.md` in that repository. No issue closure and
no PR are claimed by this report.

Implemented Desktop surface: an explicit import flow whose user decisions stay
with the user and whose bytes stay on the device.

- Device side (`local-runtime/core/knowledge_import.py`,
  `core/platform_chat.py`, `core/desktop.py`): a `knowledge-import` control
  command maps picked physical files onto the confirmed workspace generation
  (`logical_paths_for`), reads each file through the existing workspace store
  boundary (protected names, links/junctions and out-of-root paths fail
  closed), freezes identity only (plain filename, size, MIME, SHA-256, capped
  at 200 files and 50 MiB per file, extension whitelist mirroring the Server),
  and registers the frozen manifest on the platform via the authenticated
  session. A `KnowledgeImportRegistry` (SQLite) keeps per-identity display
  facts; a failed attempt is recorded as failed with its real fixed category
  and never impersonates a registration. Status emission exposes
  `knowledgeImports`/`knowledgeImportStorageError` on the existing status
  frame, owner-bound and hidden after account switch.
- Main process (`src/main/runtime.ts`, `src/main/index.ts`,
  `src/preload/index.ts`, `src/shared/desktop.ts`): one new IPC capability
  `desktop:knowledge:import` (declared in the security guardrail test) with
  KB-UUID validation, native multi-file picking and an explicit confirmation
  dialog stating that only the identity manifest is registered;
  `RuntimeProcess.importKnowledge` validates the platform KB identity and path
  list before the owned Runtime pipe and parses the frozen outcome.
- Renderer (`src/renderer/src/components/RuntimePanel.tsx`): a 本地知识导入
  section showing each registered revision (R number, document count, KB UUID,
  revision id, manifest hash) and each real failure with its error code.

| Scenario | Overall status | Current evidence and remaining required work |
| --- | --- | --- |
| T112-01 | incomplete | Automated: the registration request carries `{documents, device_id}` with identity fields only; serialized request stays under 2 KiB and never contains file bytes; manifest hashes match independently computed digests; the bundled Runtime bridge is exercised end-to-end in vitest against the real `.runtime` interpreter. Desktop and platform lists show the same revision identity (via the Server-side test in the companion report). Installed-app + live-Server + UI run with an upload observer remains unexecuted pending the named dependencies. |
| T112-02 | incomplete | Automated: import without a confirmed workspace refuses (`KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE`) with zero reads and zero posts; a switched account inherits neither workspace nor import rows; `.env` and unsupported types refuse before any upload; `node_modules/notes.md` refuses as protected; outside-root files and symlinks refuse as out-of-bounds; platform 403/404/500 rejections are recorded as real failures with empty revision fields. Unauthenticated boundary rejects with `CHAT_UNAUTHENTICATED` on the real bundled Runtime. Live UI refusal flows unexecuted. |
| T112-03 | incomplete | Automated: changed content imports as R2 with a different manifest hash; R1's stored manifest still matches its own frozen content hash and never returns R2; the device registry keeps both frozen rows. Server-side publish refusal (409) for local-import revisions is in the companion report. |
| T112-04 | incomplete | Automated: a freshly constructed registry (restart view) returns the same frozen rows for the owning identity and nothing for another identity; a replaced workspace root is detected through its recorded directory generation before mapping. Real restart of the installed Desktop with two live accounts remains unexecuted. |

Win7 is the only explicitly deferred platform verification for this stage and
is owned by closing ticket #131; it stays unexecuted and modern Windows passes
must not be read as Win7 passes.

## Commands and results

Windows host, Git Bash, Node v22.14.0 (`npm.cmd`-equivalent via PATH); Python
runtime tests run under WSL Ubuntu miniconda Python 3.13.2 with pytest.

- `npm run typecheck` -> exit 0.
- `npx vitest run` -> 23 files / 96 tests passed, exit 0 (pre-change baseline:
  22 files / 94 tests; the delta is the new bridge test file). One earlier
  full-suite run reported a single transient bundled-runtime failure during
  test contention; two consecutive clean full runs followed.
- `npx vitest run test/knowledge-import.test.ts` -> 2 passed, exit 0
  (validation without a Runtime; explicit import through the real bundled
  Runtime reaching the unauthenticated boundary).
- `wsl -e bash -lc 'cd local-runtime && python -m pytest tests/test_knowledge_import.py -q'`
  -> 16 passed (7.7s), exit 0.
- `wsl -e bash -lc 'cd local-runtime && python -m pytest tests -q'` -> 411
  passed, 11 skipped (85.8s), exit 0 (pre-change baseline: 395 passed, 11
  skipped; the delta is the new 16-test file).
- `wsl -e bash -lc 'python3.12 scripts/prepare-runtime.py'` -> reassembled
  `.runtime` so bundled tests include the new `core/knowledge_import.py`.

Not run here, staged with named dependencies:

- `npm run dist:win` Windows packaging and the installed-package launch/exit
  verification (pending packaging step for this candidate; installer SHA-256
  to be bound after packaging).
- True three-end T112-01/02/04 with a live Server, installed Desktop and
  isolated accounts A/B, devices D1/D2 (needs the running platform and real
  browser login).

## Baseline relation

Desktop baseline recorded before the change: typecheck exit 0, vitest 22
files / 94 tests passed, local-runtime pytest 395 passed / 11 skipped. All
three hold after the change with the new tests added.
