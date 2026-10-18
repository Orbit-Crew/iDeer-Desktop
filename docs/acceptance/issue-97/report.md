# Issue #97 acceptance

Execution dates: 2026-10-17 to 2026-10-18, Asia/Shanghai. Executor: Codex.
Final installed-candidate verification completed 2026-10-18 08:30:41 +08:00.
This is a candidate record, not an issue closure or release approval.
Desktop starts from a41817d. The shipped candidate is
`1f527e69bd8df3d8e924dcc88b0979ba1fe7684b`; subsequent acceptance-document commits
do not alter shipped code. The build environment records the then-untracked review
notes explicitly; no application source was dirty during the final build.
Runtime and unchanged Server signing protocol are pinned to
ccb251e07e5f5934b851e4c3df00224718f28123 in Orbit-Crew/iDeer. #96 was rechecked
closed/completed before work. No Server source was modified.

Current status: passed for the applicable modern Windows scenarios T97-01 through
T97-05. Real Win7 remains unexecuted under #131. No issue state or release was changed.

Installer: `dist/ideer-desktop-0.1.0-windows-x64-setup.exe`, SHA-256
`120836be315ca49d7433dc149abe4535a892767b1acff1d02e8e27b91113cb61`.
Installed app.asar SHA-256:
`92e0dc518ed03d3c2508796b284b7214f97cdfc0cc56c77f5a0c4ce631a06e6b`.
Installed Python SHA-256:
`4d6f5f81a4bca11191c4c7c6b43632694d0a4ce74e068619d8fdc161d469859a`.
Desktop package-lock SHA-256:
`38e20141bb06e8814177597d6164be854831e480783d38b4d41c2d1133ce857a`.
Runtime distribution.lock SHA-256:
`c29657a8392b272b9bd7aa608dc0a3d7103d47a47196a664819203cb9d803d2d`.

## Environment and commands

Modern Windows x64, build OS version 10.0.26300. Node 22.23.3 / npm 10.9.9;
Electron 22.3.27 with Node 16 compatibility and software rendering. The bundled
interpreter is CPython 3.12.10 x64. distribution.lock.json pins CPython and
cryptography 43.0.3, websockets 13.1, cffi 1.17.1, pycparser 2.22 archives and
SHA-256. package-lock.json retains the Desktop dependency lock.

Automatic lane: `scripts/verify-issue-97.ps1 -PythonExecutable .venv/Scripts/python.exe`.
Final invocation used `-EvidenceDirectory artifacts/issue-97/delivery`.
It records actual arguments, start time, duration, exit code and logs. Applicable Runtime static gate is
`python -m ruff check local-runtime --select E9,F63,F7,F82`; unchanged sources are
checked by `python scripts/verify-runtime-source.py`. Typecheck, npm test and
default `npm.cmd run dist:win` are included. Builder uses the existing fixed
winCodeSign/NSIS tool cache copied from the #96 build, without config overrides.

Latest full regression: 227 passed, 6 platform-specific skips in 19.41 seconds, and one upstream
websockets deprecation warning. Desktop: 4 files, 5 tests passed. These include
real embedded-interpreter/OS-credential/MCP contracts, not a mock interpreter.

Supplement on 2026-10-18 08:47:46 +08:00: the two symlink tests previously skipped
were rerun with an elevated test process and both passed, with zero skips.
Thus the retained full-run record is still 227 passed / 6 skipped, while the
combined evidence covers 229 passed tests and leaves only four non-Windows tests
unexecuted on this host. No application code, package or system setting changed.

## Scenario record

| Scenario | Automated result | Installed/UI result | Evidence and expected values |
| --- | --- | --- | --- |
| T97-01 | passed | passed, automated real installation/UI | Installed in D:\software\iDeer Desktop\ideer-desktop; Python 3.12.10 and all four locked dependency versions import successfully. Installed files match unpacked candidate hashes. UI starts/stops/restarts the bundled process; UI quit and native close leave no application or owned Runtime process |
| T97-02 | passed | n/a | Installed Python uses the unchanged Server protocol. Signed echo returns T97-echo-marker; managed MCP returns T97-mcp-marker with mcp-97/run-97 receipt correlation; raw stdio state also correlates tasks. See installed-signed-process.json |
| T97-03 | passed | n/a | SIGNATURE_INVALID, MESSAGE_EXPIRED, TASK_REPLAYED and LOCAL_POLICY_DENIED. Each rejected variant leaves the ledger unchanged. Completed task marker occurs exactly once. uncertain-97 writes its separate marker once before a deliberate crash and remains rejected after restart |
| T97-04 | passed | passed, automated real UI | Installed Runtime stop, forced crash, offline state and UI recovery pass. Main-frame IPC rejection, absence of old execution bridge, sandbox and navigation/CSP checks pass. MCP descendant is reaped on Runtime crash; post-crash replay does not repeat side effects |
| T97-05 | passed | passed, source/package verification | All original tests/fixtures match pinned Git blobs; full regression retained. Independent wheel builds and imports from its installed target with no backend in sys.path. Installed resource interpreter repeats signed/MCP regression. Mapping is in runtime-migration.md; Server originals remain unchanged |

The tests use 5-second protocol receive bounds, 10-second result bounds,
15-second process/connection bounds and a 5-second crash descendant bound.
Exact string/hash/state comparisons have no numeric tolerance. Fixed expected
markers and MCP execution count come from the fixture/test input, never by
copying the implementation's output into expected values.

Actual installed runner:
`scripts/windows-runtime-acceptance.ps1 -EvidenceDirectory artifacts/issue-97/installed-delivery`.
Installation exited 0 in 12.960 seconds; installed signed-process command exited 0
in 3.748 seconds; installed UI smoke exited 0 in 14.550 seconds. This is automated
UI execution by Codex, not a maintainer's manual sign-off. No human-confirmed step
is claimed. Window sizes are 960x600, 1440x900 and 1280x800. Secondary launch activates
the existing window. The final lifecycle record shows running, stopped/offline,
crashed/offline and recovered/running/not-configured.

The final full commands and exact elapsed values are committed in
[build-commands.json](evidence/build-commands.json). Installation commands,
hashes, interpreter versions, signed outcomes, process states and screenshot are
in [evidence/](evidence/). JUnit copies redact the host name, and committed logs
remove trailing blank lines; original raw artifacts remain under artifacts/issue-97/.
The two test credentials left by an
earlier interrupted run were removed; credential-cleanup.json confirms zero
remaining entries in this test namespace. No credential values are archived.

The unchanged Server protocol module in tests/server_protocol.py signs broker
requests and verifies device response signatures. This is a real cross-repository
protocol contract with a controlled peer. It does not claim a deployed Server,
database or production-device test. Test credentials are generated in OS storage,
scoped to a unique test device, omitted from evidence and deleted on cleanup.

## Preserved regression and repair

All original test files and fixtures are retained byte-for-byte, verified against
resources/provenance/runtime-source.json. Mapping and changed-file reasons are
in docs/runtime-migration.md. The Server original is retained for later cutover.

Initial full run failed the original
test_python_executor_cancellation_cleans_up_child_processes, with 226 passed and
6 skipped in 52.50 seconds. Three focused repeats reproduced a descendant marker
written while taskkill was starting. Closing the existing Windows Job Object
immediately on cancel/timeout fixed it; all 22 original Python tests and the next
full run passed. The migration records this source deviation; tests were not weakened.

The first installed UI attempt failed because async waitForFunction predicates
did not wait for the resolved IPC state. The harness now polls and awaits getStatus
with a 15-second bound and checks the real Windows exit state. A retained #96
heading assertion was also corrected. Both failed attempts remain in the local
artifacts/issue-97/installed-final and installed-recheck directories; they are not
used as passing evidence. The corrected final candidate installation was rerun.
The Standards review also corrected an installation-directory substring guard;
the exact parent-directory rejection evidence is retained.

## Review

[Two-axis code review](code-review.md) used the user-confirmed a41817d baseline.
Standards: one P2 acceptance-script defect corrected and re-reviewed, no unresolved
hard findings, one optional P3 ABI-duplication maintenance judgment. Spec: no
implementation defect or scope expansion; the initially missing unconfirmed-result
crash window was added and re-reviewed. The final package and UI conditions were
then executed successfully. Review does not claim a deployed Server or GitHub CI run.

The original two symlink skips were reproduced as WinError 1314,
ERROR_PRIVILEGE_NOT_HELD, under a non-administrator process with Developer Mode
not configured. A one-time UAC-elevated PowerShell test process then executed:
`python -m pytest local-runtime/tests/test_files.py -q -rs -k "symlink_escape_is_rejected or symlink_inside_allowed_root_is_rejected"`.
Result: 2 passed, 20 deselected in 0.28 seconds; runner exit 0, administrator=true,
elapsed 1.068 seconds. No Developer Mode, policy or permanent privilege change was
made. Evidence is in symlink-elevated-result.json, symlink-elevated-tests.xml and
symlink-elevated-tests.log. Both security assertions executed successfully.

Remaining Windows skips: POSIX process-group reaping and private-key permission-bit
tests do not apply; two no-OS-secret-backend tests apply only to non-Windows.
The original real Windows junction test passes,
as do the new Windows Job Object and OS-credential tests. Linux CI retains the
complementary POSIX/no-backend lane; it has not been executed on this Windows host.

## Win7 handoff

Real Win7 status: unexecuted. Owner/coordinator: Neowyh; follow-up
[#131](https://github.com/Orbit-Crew/iDeer/issues/131), T131-01/T131-02.
Pending: final interpreter/crypto/dependency selection, Win7 SP/patch/architecture
record, nested Job Object behavior, packaged stdlib/native DLL loading, spaced
installation path, signed protocol/MCP/DENY/replay, process exit and UI recovery.
The current CPython 3.12 candidate is modern Windows evidence only. No Win7 pass
or linz retirement is declared. Other applicable checks remain in this ticket.
