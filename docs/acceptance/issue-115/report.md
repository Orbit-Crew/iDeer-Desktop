---
id: issue-115-desktop-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 115 Desktop side of explicit server-side publication of local knowledge
last-verified: 2026-10-27
verified-against: orch/issue-115-server-publish based on 25870be (#113 candidate); the candidate is the branch tip of the same tree this evidence was produced from
---

# Issue 115 Desktop acceptance

The Desktop candidate is the isolated worktree
`G:\code\iDeer-worktrees\issue-112-desktop`, branch
`orch/issue-115-server-publish`, starting at 25870be (the #113 candidate).
The Server/Web repo carries the same branch name and starts at b379de04; its
companion report is `docs/acceptance/issue-115/report.md` in that repository.
No issue closure and no PR are claimed by this report.

Implemented Desktop surface (#115):

- `local-runtime/core/knowledge_publish.py` (new): the publication registry
  (`knowledge-publications.db`, identity-bound display facts only — no paths,
  no content) and the device-side verifier
  `verify_against_registration`, which refuses drifted, missing, or extra
  content against the registration record before a single byte leaves the
  device (`LOCAL_PUBLISH_CONTENT_DRIFTED`).
- `local-runtime/core/knowledge_import.py`: `find_registration_by_revision`
  — binding-scoped lookup so only a revision this identity registered on
  this device can ever be published from it.
- `local-runtime/core/platform_chat.py`: `publish_local_revision` —
  preview step (read-only server preview + device-side identity rows; no
  upload, no copy, no state), confirmed step (explicit `{"confirmed": true}`
  gate, then per-document upload through the platform's own multipart
  document endpoint with per-read hash re-verification, then completion and
  bounded status polling until `published`/`failed`). Every refusal is
  mapped to fixed categories (`LOCAL_PUBLISH_CONFIRMATION_REQUIRED`,
  `LOCAL_PUBLISH_CONTENT_DRIFTED`, `KNOWLEDGE_PUBLISH_REVISION_UNKNOWN`)
  and recorded as a real failed attempt; the outcome is recorded only as
  `published` or `failed`, never a fabricated success. `ChatError` now
  carries an optional machine detail while `str(error)` stays the fixed
  category.
- `local-runtime/core/desktop.py`: the `knowledge-publish` control command
  (exact key-set validation, workspace-scope binding check) and the status
  snapshot now carries `knowledgePublications` + storage health, alongside
  the existing import rows.
- `src/main/runtime.ts`: `publishKnowledge(kbId, revisionId, paths,
  confirmed)` with strict response validation for both the preview and the
  confirmed outcome, a dedicated request map, and pending-request rejection
  on runtime exit; status parsing validates publication rows.
- `src/main/index.ts`: one new reviewed IPC capability
  `desktop:knowledge:publish` — file picking, the read-only preview call,
  and the confirmation dialog (destination name, per-file summary, private
  start, visibility-application note, no-auto-sync and no-replacement note)
  stay in the trusted main process; cancel means nothing uploads.
- `src/preload/index.ts` + `src/shared/desktop.ts`: the two-argument bridge
  method (paths and confirmation never come from the renderer) and typed
  views; `test/security.test.ts` now enumerates the additional capability
  explicitly.
- `src/renderer/src/components/RuntimePanel.tsx`: a per-import
  "发布此版本到服务端…" action on registered revisions and a 服务端发布记录
  section listing published copies (resource id, slug) and failures with
  their fixed error codes, plus storage-health alerts.

Environment: Windows 10+ host, Git Bash; bundled-runtime tests ran against
the reassembled `.runtime` (`wsl python3.12 scripts/prepare-runtime.py`).
Runtime pytest used the #113-documented workaround (WSL miniconda python
against the worktree tests) because the bundled interpreter has no pytest.

| Scenario | Overall status | Current evidence and remaining required work |
| --- | --- | --- |
| T115-01 | incomplete (automated passed; installed-UI walk-through unexecuted) | Automated: `test_preview_states_destination_and_uploads_nothing` proves the preview performs no confirm/upload/completion call and records no row; `test_unconfirmed_server_refusal_is_mapped_and_recorded` proves the unconfirmed path keeps its fixed category and is recorded as a real failure. The main-process dialog (destination + file summary + cancel/confirm) is implemented but the installed-UI walk-through is staged on `npm.cmd run dist:win` packaging (not run in this stage). |
| T115-02 | incomplete (automated passed; live approval + real B retrieval unexecuted) | Automated: `test_confirmed_publication_uploads_exact_registered_content` proves the confirmed attempt sends exactly the registered bytes (`state['uploads'][0] == GUIDE.encode()`), one upload for one document, the explicit `{"confirmed": true}` gate on the wire, and the published outcome recorded with the copy identity. Server-side copy build, governance approval, and B retrieval are the Server repository report's evidence; the live cross-repo leg (installed Desktop + deployed Server + B account) is staged on packaging and deployment. |
| T115-03 | incomplete (automated passed; live two-account probe unexecuted) | Automated: `test_drifted_content_is_refused_before_any_byte_moves` (drifted original never uploads), `test_unknown_revision_cannot_publish_from_this_device` (a revision this identity never registered cannot be published; no network activity), `test_publication_records_stay_identity_bound` (a switched account inherits neither rows nor workspace). Device-side direct-query refusal for other accounts is the #113 owner-bound binding, re-verified unchanged in the Server report. |
| T115-04 | incomplete (automated passed; mid-transfer injection unexecuted) | Automated: `test_failed_build_is_recorded_as_failed_not_published` proves a failing platform build surfaces `failure_code=parse_failed` and is recorded as failed, never published; drift/unknown refusals record real failures with fixed categories; retry reuses the same server copy (Server-report evidence) and the display explains the retry semantics. There is no automatic two-way sync anywhere in the change: later imports never touch an existing publication. Real mid-transfer network injection is staged on a deployed pair. |

Win7 is the only explicitly deferred platform verification for this stage:
it stays unexecuted and is owned by the closing ticket #131 together with
the Win7 compatibility patches listed there. Modern Windows passes above
must not be read as Win7 passes. `npm.cmd run dist:win` was not run; the
installer SHA-256 will bind this report after packaging (recorded as a
pending step, not a pass).

## Commands and results

- `npm.cmd run typecheck` (via `npm run typecheck`, node 22.14.0 win-x64)
  -> exit 0.
- `npx vitest run` -> 24 files / 98 tests passed (baseline 23/96 plus the
  new `test/knowledge-publish.test.ts` with 2 tests). One flaky first run of
  the bundled-runtime test timed out before `.runtime` was reassembled;
  after `scripts/prepare-runtime.py` it passes deterministically (rerun
  once, per the documented flake procedure).
- Runtime pytest (WSL miniconda workaround, as documented in #113):
  `wsl -e bash -lc 'cd /mnt/g/code/iDeer-worktrees/issue-112-desktop/local-runtime && $HOME/miniconda3/bin/python -m pytest tests -q'`
  -> 429 passed, 11 skipped (90.8s). The bundled `.runtime/python.exe -m
  pytest local-runtime/tests` path has no pytest installed; the workaround
  is the documented equivalent.
- New runtime tests: `local-runtime/tests/test_knowledge_publish.py` —
  8 passed (real DesktopChat seam against a protocol fixture and a real
  confirmed workspace; the multipart upload is exercised end-to-end through
  the platform document endpoint contract).
- `test/security.test.ts` (capability boundary) — updated to enumerate
  `desktop:knowledge:publish` explicitly; passes in the full vitest run.

## Dependencies still required (staged portions)

- `npm.cmd run dist:win` packaging, install, start, and exit verification
  for the installed-UI legs (T115-01 walk-through, T115-02 confirm dialog).
- A deployed Server with a configured provider and a real B account for the
  live cross-repo legs (see the Server repository report).

## Baseline relation

Desktop baseline at the #113 candidate: typecheck exit 0, full vitest
23 files / 96 tests, runtime pytest 421 passed / 11 skipped
(orchestrator-recorded). After the change: typecheck exit 0, vitest 24/98,
runtime pytest 429 passed / 11 skipped — only the new publication tests
were added; no existing test regressed (the security capability list was
updated deliberately for the one new reviewed channel).

## Coexistence with #112/#113

The device registry stays append-only display facts; publication reads the
registration record and re-reads the exact files inside the confirmed
workspace boundary on every attempt, so nothing implicit is ever uploaded.
The retrieval path of #113 is untouched: publication creates a server copy
and never mutates the device KB's frozen revisions, activations, or the
device search contract; a published copy is retrieved from the platform
provider, not from the device, so the device keeps serving nothing for
teams.
