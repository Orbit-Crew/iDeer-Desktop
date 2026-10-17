# Issue #97 acceptance

Execution date: 2026-10-17, Asia/Shanghai. Executor: Codex. This is a candidate
record, not an issue closure or release approval. Desktop starts from a41817d;
the implementation commit and installer hash are bound by artifacts/issue-97/.
Runtime and unchanged Server signing protocol are pinned to
ccb251e07e5f5934b851e4c3df00224718f28123 in Orbit-Crew/iDeer. #96 was rechecked
closed/completed before work. No Server source was modified.

Current status: incomplete until installed-candidate checks and code review finish.

## Environment and commands

Modern Windows x64, build OS version 10.0.26300. Node 22.23.3 / npm 10.9.9;
Electron 22.3.27 with Node 16 compatibility and software rendering. The bundled
interpreter is CPython 3.12.10 x64. distribution.lock.json pins CPython and
cryptography 43.0.3, websockets 13.1, cffi 1.17.1, pycparser 2.22 archives and
SHA-256. package-lock.json retains the Desktop dependency lock.

Automatic lane: `scripts/verify-issue-97.ps1 -PythonExecutable .venv/Scripts/python.exe`.
It records actual arguments, start time, duration, exit code and logs in
artifacts/issue-97/commands.json. Applicable Runtime static gate is
`python -m ruff check local-runtime --select E9,F63,F7,F82`; unchanged sources are
checked by `python scripts/verify-runtime-source.py`. Typecheck, npm test and
default `npm.cmd run dist:win` are included. Builder uses the existing fixed
winCodeSign/NSIS tool cache copied from the #96 build, without config overrides.

Latest full regression: 227 passed, 6 platform-specific skips, and one upstream
websockets deprecation warning. Desktop: 4 files, 5 tests passed. These include
real embedded-interpreter/OS-credential/MCP contracts, not a mock interpreter.

## Scenario record

| Scenario | Automated result | Installed/UI result | Evidence and expected values |
| --- | --- | --- | --- |
| T97-01 | passed | unexecuted | test/runtime.test.ts uses a spaced profile path and bundled Python; test_desktop_process.py uses no Server imports. Installed UI and package process snapshots pending |
| T97-02 | passed | n/a | Server-protocol signed echo returns T97-echo-marker; managed MCP returns T97-mcp-marker, receipt/task/run match mcp-97/run-97; isolated Credential Manager identity |
| T97-03 | passed | n/a | SIGNATURE_INVALID, MESSAGE_EXPIRED, TASK_REPLAYED and LOCAL_POLICY_DENIED; counting fixture ledger remains exactly one T97-mcp-marker line |
| T97-04 | passed | unexecuted | Persistent replay admission survives restart and hard crash; Windows job removes MCP descendant. Installed IPC/UI stop/crash/recovery and quit evidence pending |
| T97-05 | passed | incomplete | Original sources/tests checked by Git blob manifest; full original regression retained; independent wheel builds. Installed interpreter rerun and final mapping review pending |

The tests use 5-second protocol receive bounds, 10-second result bounds,
15-second process/connection bounds and a 5-second crash descendant bound.
Exact string/hash/state comparisons have no numeric tolerance. Fixed expected
markers and MCP execution count come from the fixture/test input, never by
copying the implementation's output into expected values.

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

Windows skips: two symlink creation tests lack symlink privilege; POSIX process-group
reaping and private-key permission-bit tests do not apply; two no-OS-secret-backend
tests apply only to non-Windows. The original real Windows junction test passes,
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
