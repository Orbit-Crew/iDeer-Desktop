# Issue 102 acceptance

Specification: [iDeer #102](https://github.com/Orbit-Crew/iDeer/issues/102),
parent [#95](https://github.com/Orbit-Crew/iDeer/issues/95).
Prerequisite [#101](https://github.com/Orbit-Crew/iDeer/issues/101) was verified
closed/completed before implementation on 2026-10-21.

Desktop base: `9db5447c089ea835d1c20c3bf445f6f406468088`.
Server base: `aeeb9fb2c83c7a7364de0c989c7c011cb4d15ab8`.
Both implementation branches are `feat/issue-102` from the latest remote develop.

T102-01 through T102-04 passed on modern Windows in both the development
and installed application on 2026-10-23, Asia/Shanghai. Each run covered
22 subcases, 21 original operations and 4 separate recovery reads. Static,
standard, protected Real E2E,
package and installation checks passed. Earlier failures remain separate
historical evidence. Real Win7 remains unexecuted under Issue 131.

## Scenario contract registered before implementation

The user confirmed the test seams: WorkspaceFileService, signed Runtime
protocol, Desktop chat approval cards, and real Server-to-Runtime integration.
Fixtures use isolated synthetic users, profiles, SQLite databases and directories.
Expected original and replacement bytes are `BEFORE` and `AFTER`. Additional
UTF-8/newline checks must preserve the exact submitted bytes. File size limit
remains 65,536 UTF-8 bytes. Production approval timeout remains 300 seconds;
shortened test clocks belong only in isolated fixtures.

| Scenario | Planned executable entry | Required observations | Current state |
| --- | --- | --- | --- |
| T102-01 | WorkspaceFileService regression, signed protocol regression, `scripts/acceptance/issue-102/desktop.cjs` | Desktop allows create and overwrite once; exact bytes/hash, original Run/task/tool call, approval digest and durable receipt agree. | passed in both runs |
| T102-02 | WorkspaceFileService and signed protocol regressions, Server contract tests, real Desktop fixture | Reject, timeout, changed request/hash, local DENY, Web approval, outside/protected/link requests preserve original bytes; explicit error or denial. | passed in both runs |
| T102-03 | SQLite admission/completion fault fixtures through signed transport and real Desktop | Admission failure writes nothing; completion failure after effect leaves AFTER and a recoverable uncertain admission. Network failure alone does not prevent reliable local recording. | passed in both runs |
| T102-04 | Signed transport regression and real Server/Desktop restart, disconnect and cancel fixtures | No automatic redispatch before/after uncertain write; original task facts and true file bytes survive; cancellation never replaces a completed effect with a claim of no execution. | passed in both runs |

The entries above were registered before implementation. The actual
commands, exact candidate bindings and observed results below complete
those entries; historical failures do not replace the selected runs.

## Deferred platform verification

Real Win7: **unexecuted**, assigned to Neowyh under
[#131](https://github.com/Orbit-Crew/iDeer/issues/131). Pending checks include
installation, launch/exit, Electron 22 software rendering, bundled Python and
native cryptography/WebSocket dependencies, Windows file-handle pinning,
Credential Manager, approval cards, writes, cancellation and receipt recovery.
Modern Windows results do not establish Win7 compatibility or authorize linz
retirement.

## Candidate and environment

Desktop product/test/build source SHA-256:
`470acfab60d10f98d496768b63f60fa66a1e77654eabe9b752d29e704c57de82`.
The [source binding](evidence/desktop/desktop-source-binding.json.gz) records
every input hash, the branch and HEAD at execution. Acceptance scripts are
bound separately by each functional run. The candidate includes uncommitted
changes over the fixed points above; a later commit does not alter those bytes.

Host: Windows 11 Pro 10.0.26300 x64. Build Node 22.23.3, test Python 3.12.8,
bundled Python 3.12.10. Exact test dependencies and component locks are in the
[environment record](evidence/environment/manifest.json) and
[lock hashes](evidence/desktop/lock-hashes.json).
The [execution environment](evidence/environment/execution.json) rechecks the
host, toolchain and installed Runtime UTF-8 pipe mode on 2026-10-23. The bundled
distribution locks cryptography 43.0.3, cffi 1.17.1 and websockets 13.1; these
are distinct from the test environment's cffi 2.1.1.

The original ignored `.runtime` directory returned Windows permission errors.
The selected build and Runtime suite used a fresh source-identical mirror at
`artifacts/issue-102/build-utf8`, with
[per-file inputs](evidence/desktop/build-utf8-inputs.json.gz) recorded before building.
The installed application uses its own packaged Runtime.

Installer SHA-256:
`63c0e751cd1e637a1c46abe0a50e64128226c89620c86b1ae187d71a169a9add`.
All executable, ASAR and Python hashes are recorded in
[package hashes](evidence/desktop/package-hashes.json). Installed location:
`D:\software\iDeer Desktop\ideer-desktop`.

## Automated Desktop gates

These gates ran on 2026-10-22. Each linked JSON records the exact command,
working directory, UTC start/end, exit code and duration; its adjacent
`.log.gz` contains captured output. Exit code was 0 for every row.
The build uses the existing `.cache/electron-builder` tool cache. Runtime tests
set `PYTHONUTF8=1` and `PYTHONPATH` to the mirror's `local-runtime` package, with
a new unique base-temp directory. Product startup independently forces UTF-8
with `-X utf8`; isolated Python does not depend on that test environment variable.

| Command | Observed result | Seconds | Record |
| --- | --- | ---: | --- |
| `npm.cmd run typecheck` | passed | 6.516 | [command](evidence/desktop/typecheck-release.json) |
| `npm.cmd test` | 19 tests in 10 files passed | 10.860 | [command](evidence/desktop/desktop-tests-release.json) |
| `npm.cmd run test:security` | passed | 2.781 | [command](evidence/desktop/security-release.json) |
| `npm.cmd run verify:provenance` | passed | 0.750 | [command](evidence/desktop/provenance-verified.json) |
| `python -m ruff check local-runtime --select E9,F63,F7,F82` | passed | 0.329 | [command](evidence/desktop/runtime-static-verified.json) |
| `python scripts/verify-runtime-source.py` | passed | 0.140 | [command](evidence/desktop/runtime-source-verified.json) |
| `python -m pytest local-runtime/tests -q` with isolated base temp and JUnit output | 321 passed, 6 skipped, 2 dependency deprecation warnings | 95.734 | [command](evidence/desktop/runtime-tests-verified.json) |
| `npm.cmd run dist:win` | Windows x64 installer built | 68.250 | [command](evidence/desktop/dist-win-release.json) |
| `powershell .../issue-101/install_lifecycle.ps1` with this installer | passed | 44.687 | [command](evidence/desktop/install-lifecycle-release.json) |

The installation check exercised the actual Electron UI, sandbox, IPC, CSP,
sidebar, second-instance behavior, UI quit and native close. It verified
shortcuts, uninstall data retention, reinstall and the installed ASAR hash.
The [lifecycle result](evidence/desktop/lifecycle/lifecycle-results.json) and
[profile restoration](evidence/desktop/lifecycle/profile-restoration.json)
record successful cleanup and restoration. Automation was performed by Codex;
no separate human acceptance click or confirmation is claimed.

The six Runtime skips comprise two symlink tests whose creation API was
unavailable, two non-Windows secret-store cases and two POSIX process/mode-bit
cases. They are recorded as skipped. The required Windows link-escape scenario
uses an actual junction in T102-02; both functional runs verified its rejection.

## Server gates

Server's exact candidate product/test/build fingerprint is
`25f252b5667478435775e11ba2798cbaa14fc513d59dab7a0c35a8ee5f3779b4`.
`bash scripts/run-test-lane.sh pr-standard` passed with exit 0 in 1751.642
seconds on 2026-10-22. The [command record](evidence/server/server-pr-standard.json)
and adjacent compressed full output retain every stage.

| Stage | Actual result | Lane seconds |
| --- | --- | ---: |
| local-runtime | 230 passed, 4 skipped | 33 |
| backend-standard | 26,895 passed, 237 skipped, 1,082 warnings | 1180 |
| frontend-standard | Rstest 1,270 tests / 167 files; Vitest 10,565 tests / 355 files passed | 440 |
| frontend-smoke | 35 browser tests passed | 77 |

The isolated Server uses locked Python 3.12.3, Node 22.23.2 and pnpm 10.26.2.
Fifty copied console-script entrypoints initially referenced the main
workspace's Python. Only their interpreter paths were repaired within the
isolated environment. The same 743-test comparison passed using the explicit
isolated Python and again through the repaired standard entrypoint. No test
runner or product configuration was changed to bypass those checks.

`QA_ISOLATED=1 PORT=48102 bash backend/scripts/run-real-e2e.sh` passed on
2026-10-23 with exit 0 in 276.285 seconds: 7 passed, 5 skipped. The production
frontend build and active authentication/RBAC/workflow browser paths ran against
the real isolated backend. The five opt-in external-model/knowledge-evidence
cases retain their configured skips; no external-provider validation is claimed.
The write-specific real Server/Desktop/Runtime scenarios run separately below.
See the [command](evidence/server/server-real-e2e.json) and its full compressed log.

The E2E script's automatic cleanup printed permission errors for immutable
test resource-version directories. A separate cleanup verified the exact
run-owned temporary path, UID 1000 ownership for all 985 entries, zero symlinks
and closed ports 48102/3101 before making only its owned directories writable
and removing them. The [cleanup result](evidence/server/server-real-e2e-cleanup-result.json)
records `targetAbsent=true`. The original warning is preserved, and automatic
cleanup is not presented as successful.

Changed Server source files also passed the recorded
[Ruff check](evidence/server/ruff-final.json),
[format check](evidence/server/format-final.json) and
[Python compilation](evidence/server/compile-final.json).

After both functional runs, the document, upstream-patch, test-inventory and
agent-guidance checks passed again. Complete all-scope GitNexus analysis mapped
16 files, 32 symbols and 25 affected flows, with critical risk and no partial or
truncated output. The changed authorization, canonical Run and terminal-receipt
flows are covered by the focused regressions, standard lane and real scenarios.
See the [complete graph output](evidence/server/detect-changes-delivery.json.gz)
and [final detection command](evidence/server/detect-changes-structured-final.json).

The [Server report](evidence/server/report.md) is an exact snapshot from local
commit `6db05ea55d8482b3babea612a9dd9dcd695d952f`; its relative documentation
links belong to the Server repository. The
[delivery record](evidence/server/delivery.json) and
[complete commit patch](evidence/server/server-commit.patch.gz) allow review
without a remote push. The isolated Server working tree was clean after commit.

## Historical results

[Earlier attempts](evidence/attempts/README.md) retain failed/unexecuted results,
their actual commands and cleanup limits. The selected final command records
are separate. The original permission failures, Unicode regression, incomplete
business-login attempt and superseded Server lane are not counted as passing
functional evidence.

## Functional execution

Executed on modern Windows by Codex automation using actual Electron approval UI clicks, the bundled Runtime and the real isolated Server. Synthetic accounts pair through the real API. The fixture supplies the native folder-dialog selection, deterministic model responses, owned SQLite faults and explicit network loss. No independent human walkthrough or confirmation is claimed.

The installed run started `2026-10-23T05:24:32.855Z` and finished `2026-10-23T05:31:17.789Z`. Its exact command exited 0 in 407.531 seconds. The companion development run exited 0 in 401.344 seconds. Both independently passed all 4 scenarios, 22 subcases and 21 original operations. Separately recorded auxiliary read operations numbered 4 in the installed run and 4 in development; these are real additional requests, not included in the 21 original operations.

[Installed command](evidence/desktop/functional-final-command.json), [installed result](evidence/functional/result.json), [development command](evidence/desktop/functional-development-command.json), [development result](evidence/development/result.json), and their wire-event records retain actual inputs and correlations.

| Scenario | Observed result in both runs | Status |
| --- | --- | --- |
| T102-01 | Create, overwrite and Unicode/CRLF write match actual file bytes, request digest, original Thread/Run/task/tool call and archived approval receipt. | passed |
| T102-02 | Reject, real 300-second timeout, changed hash, Web approval, local DENY and all three boundary requests preserve BEFORE with explicit rejection and no completed write. | passed |
| T102-03 | Admission fault prevents a row and effect. Completion fault leaves AFTER plus uncertain admission; another write is blocked. Restart does not redispatch; actual saved reads demonstrate storage recovery. | passed |
| T102-04 | Cancellation before submission has zero dispatches. Cancel/disconnect before write preserves BEFORE. After-write interruption preserves AFTER and one execution, recovers the original receipt and does not resume the cancelled Run. | passed |

| Fixed bytes | UTF-8 byte count | SHA-256 |
| --- | ---: | --- |
| `BEFORE` | 6 | `c341c7fe1027f9487e8019198223ad7af0b9cfe1564d41c7e7c4d139cd0226f3` |
| `AFTER` | 5 | `94c3f1415d2061d05e4cce4d33e43e26a5ad7ebcf6e89acace6e8b84240a629c` |
| `NEWLINES` | 17 | `c1e898357fcb2824b595e53ac85efef2e4935c6a0c197791147c708fab47d91c` |

The timeout runs use the original 300-second prompt timeout, 305-second signed task deadline and 45-second observation allowance. When the long SSE stream disconnects, the runner clicks the actual recovery button for the original Thread/Run, with at most three attempts and no new submission. Each recorded dispatch remains unique. Textarea display normalizes CRLF, while the independent raw-file check retains all 17 submitted Unicode/newline bytes.

The installed wrapper backed up the current-user Runtime profile, used a marked synthetic replacement and restored every original file hash and count after Desktop exited. Both runs removed their six synthetic credentials, closed Desktop and the Gateway, and removed only their owned temporary directory. [Profile restoration](evidence/functional/profile-restoration.json) records the before/after equality. No real disk was filled and no production profile was fault-injected.

The earlier uncertain record remains protected. Each subsequent Runtime restart conservatively pauses new writes again; a separate real canonical read saves a new receipt to verify current storage, then the runner reopens the original write Run. These auxiliary reads never approve, clear or redispatch that write. Their separate Thread/Run/task IDs, BEFORE hash, completed receipt and one-dispatch/execution checks are retained in `auxiliaryOperations`.

## Evidence verification and delivery

The final evidence validator checks all 22 subcases, the four auxiliary reads,
original request and receipt correlations, actual file hashes, cleanup, profile
restoration, package/source bindings and the evidence manifest. It also rejects
credential fields and verifies that staged evidence bytes match the manifest.
Both the working-tree and staged bundle passed. The exact commands are
`python scripts/acceptance/issue-102/validate_evidence.py --root .` and the same
command with `--staged`. Development and installed runs also passed independent
`--functional` validation.

Implementation and evidence are delivered as local commits on `feat/issue-102`
in both repositories. No remote push, pull request, or issue closure is included.
