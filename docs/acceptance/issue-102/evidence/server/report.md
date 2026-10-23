---
id: issue-102-server-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 102 Server bounded workspace write implementation and validation
last-verified: 2026-10-23
verified-against: feat/issue-102 based on aeeb9fb2c83c7a7364de0c989c7c011cb4d15ab8
---

# Issue 102 Server acceptance

Issue: https://github.com/Orbit-Crew/iDeer/issues/102

The Server candidate is based on develop commit
`aeeb9fb2c83c7a7364de0c989c7c011cb4d15ab8` in the isolated checkout
`/home/neowyh/.codex-worktrees/ideer-issue102-server-20261021`.
The branch is `feat/issue-102`. No push or issue closure is included.

Desktop base: `9db5447c089ea835d1c20c3bf445f6f406468088`, also on `feat/issue-102`.
Installer SHA-256: `63c0e751cd1e637a1c46abe0a50e64128226c89620c86b1ae187d71a169a9add`.
Installed ASAR SHA-256: `aad49fc821cbf59aa570ee6e9f35ee1a0f72dc24925081fe21be702bc5a5df77`.
Installed executable SHA-256: `417dcea6c92bbd1390de26abf862207522513855b8b47b6f874a485902d2d72b`.
Bundled Runtime Python SHA-256: `4d6f5f81a4bca11191c4c7c6b43632694d0a4ce74e068619d8fdc161d469859a`.

The candidate dispatches signed `local.files.write` only through the canonical
Run path. Consent is available only in the local Desktop. Unknown write outcomes
remain unknown and are not replayed. Late signed receipts retain their original
Run identity, including when a transport failure follows the receipt.

## Candidate and regression evidence

The seven product files and six test files are recorded in the source binding.
The final broker SHA-256 is
`c2666418152417d9bc9cf93df65ee04dfa6396e781e029f090f3f4c99c98020e`.
The original 13-file patch SHA-256 is
`7342f215f5986f0485619e3328bfb2b449c687381d1cf965630abaa756fa1120`.
Documentation added after that binding does not change those product bytes.
The complete product/test/build source SHA-256 is
`25f252b5667478435775e11ba2798cbaa14fc513d59dab7a0c35a8ee5f3779b4`.
This matches the Server loaded by the Windows functional fixture.

The Server environment is WSL2 Linux 5.15.167.4, Python 3.12.3, Node 22.23.2,
and pnpm 10.26.2. Frozen dependency synchronization completed before the gates.
The backend uv.lock SHA-256 is
`5484082ec314c5933225ef852a5c7708bd60c02870472e81a11a8dea0d4d54af`.
The frontend pnpm-lock.yaml SHA-256 is
`3ff4163ee66e540357d2f0fed3c03c034ed8bc68c4549ead0d9cf8271a866131`.

The terminal-receipt transport-race regression was red with 8 failures and
2 passes, then green with all 41 broker tests passing in 16.66 seconds.
The final 13 Python files passed Ruff checking, formatting, and compilation.
Independent Standards and Spec review each reported zero unresolved findings.

## Environment correction

The first pr-standard attempt was terminated after the candidate was superseded.
It exited 143 after 1903.138 seconds and is retained as an unsuccessful attempt.
Its backend setup errors were traced to copied virtual-environment console scripts
whose shebangs still selected the main checkout's Python and private config.
Two failing files passed 743 tests in 54.37 seconds using the isolated Python.
All 50 stale Python and Python 3 console-script shebangs were then corrected in
the isolated environment only. No product, runner, or test bypass was introduced.
The normal `uv run --no-sync pytest` entrypoint passed the same 743 tests in
44.675 seconds. Exact command, cwd, elapsed time, and exit code are recorded.

## Long consent timeout observation

The first full DEV attempt passed create, overwrite, Unicode/newlines, and
explicit rejection, then its UI observer timed out after the unanswered consent.
The safe, read-only persisted-state evidence shows the original Run ended with
`success` at 2026-10-22 23:37:03.155 UTC, with `run.end` at 23:37:03.135 UTC.
The original task's signed receipt was `denied`, with consent `denied` and
`DENIED` as the error code. The Server accepted and acknowledged that receipt.
The harness had retained a stale UI snapshot after the long SSE connection
disconnected. This attempt is not a full scenario pass. The corrected harness uses the
real Desktop reconnect control and rereads that same original Run. The final
DEV and installed-package runs both passed this scenario. No Server product
change or automatic write redispatch was made for this observation.

## Completion gates

The final command `bash scripts/run-test-lane.sh pr-standard` passed with exit 0.
It ran from the isolated repository root from 2026-10-22 12:11:57 UTC to
12:41:08 UTC, taking 1751.642 seconds. The parent runner reported
`TEST_LANE_DURATION lane=pr-standard seconds=1751 status=0`.

| Included stage | Result | Runner duration |
| --- | --- | --- |
| local-runtime | 230 passed, 4 skipped | 33 seconds |
| backend-standard | 26,895 passed, 237 skipped, 1,082 warnings | 1,180 seconds |
| frontend-standard | Rstest 1,270 passed in 167 files; Vitest 10,565 passed in 355 files | 440 seconds |
| frontend-smoke | 35 browser tests passed | 77 seconds |

Skipped tests remain skipped; the pass does not assert live-provider coverage.
The protected real-browser E2E command is `QA_ISOLATED=1 PORT=48102 bash
backend/scripts/run-real-e2e.sh`, with an isolated database and seeded test
identities. It uses the real backend and browser. External real-model testing is
not enabled in this lane.

The protected real-browser lane exited 0 after 276.285 seconds.
Its final summary reports 5 skipped, 7 passed (4.3m).
The original cleanup emitted
permission errors for read-only resource version directories; the wrapper still
returned zero. A separate cleanup verified all 985 remaining entries belonged to
the test user, found no symlinks, verified backend/frontend ports closed, restored
owner write permission on the affected directories, and removed only this run's
exact temporary directory. The supplemental cleanup result confirms it is absent.
The original warnings and the supplemental result are both retained.

The document checker, upstream patch checker against the develop base, test
inventory, and agent-guidance mirror check passed. Complete GitNexus all-scope
analysis mapped 16 changed files, 32 symbols, and 25 affected execution flows,
with critical risk. The structured output contains no partial or truncated flag.
The changed broker, canonical Run binding, and terminal-receipt flows were
independently reviewed and covered by the focused and standard suites.

Exact commands, cwd, start/end timestamps, elapsed time, exit codes, compressed
full logs, and raw source bindings are retained in the companion iDeer-Desktop
`docs/acceptance/issue-102/evidence/server/` evidence. The companion
`docs/acceptance/issue-102/report.md` owns T102-01 through T102-04, installed
package hashes, UI screenshots, file readback, cleanup, and profile restoration.
Those scenario results must be checked there before declaring Issue 102 accepted.

## Cross-repository functional acceptance

The final DEV run passed all T102-01 through T102-04 scenarios, including 22
subcases, 21 primary canonical requests, and 4 auxiliary recovery reads.
It ran from `2026-10-23T00:06:22.802Z` to `2026-10-23T00:13:03.705Z`, taking 401.344 seconds with exit 0.
The result JSON SHA-256 is `5eb32460b2975b73f67d59e18dfd0c652f71575f8442ac3ae47b8b24ba75d53d`.
Its credential cleanup removed all six synthetic references without failure;
the owned fixture was removed and the Desktop app was closed.

| Scenario | DEV | Installed package |
| --- | --- | --- |
| T102-01 | passed, 3 subcases | passed, 3 subcases |
| T102-02 | passed, 8 subcases | passed, 8 subcases |
| T102-03 | passed, 6 subcases | passed, 6 subcases |
| T102-04 | passed, 5 subcases | passed, 5 subcases |

The installed-package run passed the same 22 subcases, 21 primary requests, and 4 auxiliary recovery reads. It ran from `2026-10-23T05:24:32.855Z` to `2026-10-23T05:31:17.789Z`, taking 407.531 seconds with exit 0.
Its result JSON SHA-256 is `e5493ac981f09d5da575443f2977e8b8b61265f4eca10a781b5542fe82dad704`.
The installed executable and bundled Runtime were used. Synthetic credentials,
owned fixtures, and application lifecycle cleanup passed. The companion Desktop
report binds the installer, executable, ASAR, Runtime, and profile restoration
hashes. Modern Windows functional acceptance is passed; no human click-through
or Windows 7 pass is claimed.

Late recovered evidence is checked through the owner-authenticated
`GET /api/devices/receipts/{task_id}` durable endpoint. Its original Run/task/hash,
completed receipt, approval basis, receipt identity, and acknowledgment are
verified while cancelled Runs stay interrupted. The online TaskResponse may
retain no receipt when its live result was lost. This separation follows
[the durable recovery contract](../../local-runtime/ARCHITECTURE.md#durable-receipt-recovery-issue-101),
and does not redispatch or resume a write. Web denial is HTTP 403 with typed
`detail.code=LOCAL_APPROVAL_REQUIRED`; the legacy outer envelope retains
`error.code=INTERNAL_ERROR`. No Server product change was made to alter either
existing contract for the acceptance harness.

Windows 7 verification is unexecuted and deferred to issue 131, owner Neowyh.
The current Windows acceptance is run by UI automation; it is not a claim that a
human operator performed the clicks.
