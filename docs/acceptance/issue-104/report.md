# Issue 104 acceptance

Specification: [iDeer #104](https://github.com/Orbit-Crew/iDeer/issues/104).
Prerequisite #102 was verified closed/completed on 2026-10-23.
Desktop branch `feat/issue-104` starts at `8901c17` from `origin/develop`.
Server branch of the same name starts at `14fcfef98` in an isolated WSL worktree.

The user confirmed the Desktop UI, signed Runtime protocol, real file bytes and
execution counts, and real Server-to-Runtime recovery as TDD boundaries.

## Scenario contract

Independent file constants are UTF-8 `BEFORE`, `AFTER`, and `SECOND`. Hashes
are computed directly from those constants. There is no byte/hash tolerance.
Production write limits remain 65,536 bytes and approval timeout 300 seconds.
Automated UI and network observations have a 90-second deadline per wait.
Fixtures use isolated A/B identities, temporary directories, and databases.

| Scenario | Entry | Expected observations | Status |
| --- | --- | --- | --- |
| T104-01 | `test_platform_chat.py::test_stop_records_request_separately_from_final_run_and_never_submits_another_turn`; signed `local-stop` case in `test_workspace_writes.py`; `scripts/acceptance/issue-104/desktop.cjs` | Stop request separate from terminal Run; pending and subsequent writes blocked; committed AFTER retained; task/tool/UI/file observations separate | incomplete |
| T104-02 | signed `duplicate-after`, `cancel-after`, `disconnect-after` cases; real Desktop fault runner | Pre/post-effect disconnect preserves unknown effects; one execution; duplicate task/status/receipt never repeats a write | incomplete |
| T104-03 | stop protocol test and real Desktop cancellation/late-upload runner | Both race orders; original Task/Run identity retained; late receipt updates history without restarting terminal Run | incomplete |
| T104-04 | `test_receipt_ledger.py::test_thread_history_survives_restart_and_keeps_signed_upload_metadata_unchanged`; real Desktop/Runtime/Server restart runner | Original Thread restores approval/execution/upload facts; unverifiable effect stays unknown; no automatic write resubmission | incomplete |

The real runners are implemented and syntax-checked. The restartable real
Server fixture reached READY and restarted its process once during setup,
before the final Server implementation was complete. That setup check is not
functional evidence for T104-01 through T104-04.

## Candidate and executed checks

Execution: 2026-10-24, Asia/Shanghai. Windows 11 Pro 10.0.26300 x64; build Node
22.23.3; test Python 3.12.8; bundled Python 3.12.10. The host's default Node 24
was not used for the final npm build/test commands. The
[environment and dependency locks](evidence/environment.json) record both.

Desktop product/test/build source SHA-256:
`95cfa02cea3b7a110ac07fa07444fcfca2baa52296a2c24b686daf8746eaf891`.
The [per-file binding](evidence/source-binding.json) binds the tested bytes over
the develop base. Acceptance runners are separate source files in this branch.
The committed Desktop implementation is
`bc81f076fd1465d2d93ebb372eda34545152be88`; the
[delivery check](evidence/delivery.json) confirms its product/test/build bytes
match the tested source binding exactly.
Server code is saved in its independent `feat/issue-104` worktree but is not
committed or fully validated yet. No combined candidate is approved.

Installer SHA-256:
`d2ece2ab57c55aca6faf18dfb187825a11a19502da2dc3a611785ce9100d003a`.
The [package hashes](evidence/package-hashes.json) verify the installed ASAR
equals the candidate ASAR and all 26 installed/packaged Runtime source files
equal the tested checkout. The installed Python matches the assembled Runtime.

Each command record retains exact arguments, working directory, UTC timestamps,
elapsed time and exit code, with complete output in an adjacent `.log.gz`.

| Command | Result | Seconds | Record |
| --- | --- | ---: | --- |
| `npm.cmd run typecheck` | passed | 7.609 | [record](evidence/checks/typecheck-reviewed.json) |
| `npm.cmd test` | 22 tests in 11 files passed | 8.735 | [record](evidence/checks/desktop-final.json) |
| explicit test Python `-m pytest local-runtime/tests -q`, isolated temp and JUnit | 346 passed, 6 skipped, 2 warnings | 85.938 | [record](evidence/checks/runtime-final-explicit.json) |
| `npm.cmd run test:security` | passed | 5.359 | [record](evidence/checks/security-final.json) |
| `npm.cmd run verify:provenance` | passed | 0.969 | [record](evidence/checks/provenance-final.json) |
| explicit test Python `-m ruff check local-runtime scripts/acceptance/issue-104 --select E9,F63,F7,F82` | passed | 0.203 | [record](evidence/checks/runtime-static-final.json) |
| explicit test Python `scripts/verify-runtime-source.py` | passed | 0.156 | [record](evidence/checks/runtime-source-final.json) |
| `npm.cmd run dist:win` | Windows x64 NSIS built | 47.890 | [record](evidence/checks/dist-win-final.json) |
| `scripts/acceptance/issue-101/install_lifecycle.ps1`, final installer | install, sandbox/UI/IPC, quit/close, uninstall preservation and reinstall passed | 37.609 | [record](evidence/checks/install-final.json) |

The six Runtime skips are two unavailable symlink-creation cases, two
non-Windows secret-backend cases, a POSIX process-group case and a POSIX mode-bit
case. Exact reasons are in [JUnit](evidence/checks/runtime-final.xml.gz).
Windows junction protection remains covered by the executed Runtime suite.
The two warnings are the existing websockets close-code deprecation.

The [installation results](evidence/installation/lifecycle-results.json) and
[profile restoration](evidence/installation/profile-restoration.json) show that
the original three Runtime profile files were restored with unchanged hashes.
This installed smoke covers the application boundary; it does not stand in for
the pending authenticated stop/recovery scenarios.

## Functional evidence and outstanding work

T104-01 protocol evidence includes separate requested/uncertain cancellation,
explicit retry, prompt cancellation, a durable Run fence across TaskGuard
reopening, blocked subsequent writes, and retained AFTER bytes after commit.
T104-02/03 protocol evidence includes duplicate signed tasks without a fabricated
replacement receipt, pre/post-effect cancellation, disconnect after effect and
immutable completed/uncertain receipt facts. T104-04 storage evidence includes
Thread-scoped history after reopening the ledger, account isolation and exact
unchanged signed upload metadata. These are part of the 346-test Runtime result.
The rendered chat UI contract checks separate Server/local facts and stop retry.

The new real runner covers the following controls with original identities:

- Stop while awaiting approval and after a first write before a second write.
- Disconnect before execution and after committed writes, then reconcile.
- Stop after effect with held receipt delivery; upload after terminal Run.
- Duplicate a signed task and the original receipt with dropped acknowledgments.
- Crash/restart Runtime, reopen Desktop, and restart the real Server process.

These real cross-repository operations and authenticated UI steps remain
**unexecuted** on the final combined candidate. Manual sign-off is also
unexecuted; automated checks were run by Codex, not by a human confirmer.
The Server worktree has green focused cancellation/history/HTTP/migration
checks from its implementation session, but its remaining replay/admission
race fixes, standard gates, review and commit are unfinished. Those results are
not claimed as final Server or cross-repository acceptance here.

The local WSL service repeatedly returned `Wsl/Service/0x8007274c`, including
for an empty command, and prevented further Server execution. Permission to
restart shared WSL was requested because doing so interrupts other WSL
processes. The worktree files are preserved. This is an environment blocker,
not an exception to any mandatory scenario or gate. Do not close Issue #104
while these combined scenarios remain incomplete.

## Review and diagnostic attempts

[Independent Standards and Spec review](code-review.md) found 0 Standards
issues and 3 Spec issues. All three were fixed, covered by failing-then-passing
regressions and source-reviewed again, leaving 0 open review findings.

The [attempt records](evidence/attempts) retain unsuccessful runs. The first
package attempt failed extracting macOS symlinks from the build-tool cache;
the final build used a copied existing cache. A concurrent test/package attempt
hit a loaded Runtime `.pyd` and invalidated two packaged-process tests; the
Runtime was rebuilt and both full suites then passed in sequence. One command
resolved `python` to a host interpreter without pytest; the final command uses
the explicit tested interpreter. These attempts do not count as passing gates.

## Platform scope

Modern Windows is the current acceptance platform. Real Win7 is unexecuted,
owned by Neowyh under [#131](https://github.com/Orbit-Crew/iDeer/issues/131).
Pending Win7 checks include installation/startup/exit, Electron 22, bundled
Python/cryptography, Windows file-handle protections, cancellation, persistent
task identity, and receipt recovery across all three component restarts.
