# Issue 104 acceptance

[iDeer #104](https://github.com/Orbit-Crew/iDeer/issues/104) adds scoped Turn
stopping and recovery in the original Thread. T104-01 through T104-04 passed
in development and in the final installed Windows package. Server full gates
are running; combined delivery remains incomplete until their results and
commit are recorded.

Execution date: 2026-10-24, Asia/Shanghai. The final development flow ran
09:57:08 through 09:58:41; the installed flow ran 10:00:10 through 10:01:40. Command records
retain UTC timestamps. Codex performed automated execution and UI inspection.
The specified UI steps were automated; no human sign-off is claimed. Prerequisite #102
was verified closed/completed on 2026-10-23.

## Candidate and environment

Both repositories use `feat/issue-104` from develop. Desktop base is
`8901c170c02afbb10adee994ed2058c90d9045bb`; Server base is
`14fcfef9894b72f19fb819d186c2d800e3862062`.

Desktop implementation commit: `b84abf1d40f0b90bcc68d546f9cc58e40dbf897d`.
Product/test/build source SHA-256:
`3d55ead215f80025dbc4ac6059b6bcca3f3e33ac6ce01c18a0edcdbd6a6df46b`.
The [per-file binding](evidence/source-binding.json) records those bytes.
Acceptance-runner hashes are recorded separately in each functional result.

Server implementation commit: pending final gates and commit.
Final functional candidate source SHA-256:
`715af6c8605e08354f203bca9f31031e8333704b9e4519de01bac8483305d307`.
The [development](evidence/development/server-source-binding.json) and
[installed](evidence/installed/server-source-binding.json) bindings contain the
same Server bytes. Their `headAtBinding` is the develop base because tests
preceded the commit; the delivery record must verify the committed source.

Windows 11 Pro 10.0.26300 x64; Node 22.23.3; test Python 3.12.8; bundled Python
3.12.10; Electron 22.3.27. The host's default Node 24 was not used for final npm
commands. [Environment and dependency-lock hashes](evidence/environment.json)
record versions and locks. Fixtures use isolated A/B identities, temporary
directories, fresh SQLite databases, loopback HTTP/WebSocket, and a deterministic
model selecting the real authorized file tool. Actual Gateway/Runtime code
handles signing, delivery, approval, cancellation, receipts, persistence and
file effects. No external model call is claimed. Directory selection uses the
existing native-dialog adapter; approval and Stop use rendered Desktop buttons.

Final `ideer-desktop-0.1.0-windows-x64-setup.exe` SHA-256:
`89128b82a2857e637d686cf09ce4a2d79c5b6e0506a5f5525042c5125d8ca2f9`.
[Package hashes](evidence/package-hashes.json) verify installed/candidate ASAR
equality, all 26 Runtime core files across checkout/assembled/package/installed
copies, and matching assembled/installed Python. Installation is at
`D:\software\iDeer Desktop\ideer-desktop`.

## Scenario contract and results

The user confirmed Desktop UI, signed Runtime protocol, real file bytes and
execution counts, and real Server-to-Runtime recovery as TDD boundaries.
Independent expected UTF-8 literals are `BEFORE`, `AFTER` and `SECOND`.
BEFORE is 6 bytes, SHA-256
`c341c7fe1027f9487e8019198223ad7af0b9cfe1564d41c7e7c4d139cd0226f3`;
AFTER is 5 bytes, SHA-256
`94c3f1415d2061d05e4cce4d33e43e26a5ad7ebcf6e89acace6e8b84240a629c`.
There is no byte/hash tolerance. Production limits remain 65,536 write bytes
and 300 seconds for approval. UI/network waits have a 90-second deadline.
`cancel_requested` remains unverified until a receipt establishes the fact;
the UI states this explicitly. Disconnect uses `RESULT_UNCERTAIN` and
`result_not_verified`; a verified cancel receipt uses `CANCELLED`. These
states do not infer actual file contents.

[Reproduction instructions](../../../scripts/acceptance/issue-104/README.md)
bind the real restartable Server fixture, controls and UI runner. Each final
run executes 9 fault operations and 2 auxiliary read-only storage health checks.
The reads preserve uncertain write records and never repeat their effects.
Results retain original Thread/Run/Task IDs, dispatches, tool returns, audit
execution counts, file bytes/hashes and recovered UI/history facts.

| Scenario | Actual controls and independent observations | Development | Installed |
| --- | --- | --- | --- |
| T104-01 | Stop pending approval: BEFORE, 0 executions. Commit first write, stop before second: first AFTER, second BEFORE, 1 execution. Request and terminal Run are separate. | passed | passed |
| T104-02 | Disconnect before execution: BEFORE, 0 executions. Disconnect after effect: AFTER, 1 execution, Server unverified/local upload pending; reconnect does not redispatch. | passed | passed |
| T104-03 | Effect before stop, hold/upload late receipt: AFTER, 1 execution, Run remains interrupted. Duplicate signed task/original receipt with dropped ACK: AFTER, 1 execution, 3 receipt uploads. | passed | passed |
| T104-04 | Crash/restart Runtime, quit/reopen Desktop, restart actual Gateway. Reopen original Threads: identities retained, BEFORE, 0 executions, cancellation/unverified history retained, no automatic resubmission. | passed | passed |

T104-01 covers stop before completion; T104-03 covers completion before stop.
After late upload, `success` remains `success` in the disconnect case and
`interrupted` remains `interrupted` in the stop case. Committed AFTER bytes
remain. Each original task card must render matching Server/local/delivery
facts before capture. Tool/Run returns, UI and file effects are separate checks.

Development [result](evidence/development/result.json.gz),
[wire events](evidence/development/wire-events.jsonl.gz),
[image hashes](evidence/development/images.json),
[late-stop screenshot](evidence/development/late-stop-pending-upload.png).
Installed [result](evidence/installed/result.json.gz),
[wire events](evidence/installed/wire-events.jsonl.gz),
[image hashes](evidence/installed/images.json),
[Runtime-restart screenshot](evidence/installed/runtime-restart-restored.png).
Each directory has 8 screenshots and Server restart evidence. Both runs removed
6 synthetic secret references with 0 failures, removed temporary files, closed
Desktop and exited the fixture Gateway. Installed
[profile restoration](evidence/installed/profile-restoration.json) proves all
3 original current-user Runtime files kept their hashes. Selected evidence
excludes ready manifests, credential-reference lists, JWTs, private keys and
Runtime settings.

## Executed commands

Each command record retains arguments, working directory, UTC times, duration
and exit code. Its adjacent `.log.gz` contains complete command output.

| Command | Result | Seconds | Record |
| --- | --- | ---: | --- |
| `npm.cmd run typecheck` | passed | 5.859 | [record](evidence/checks/typecheck-reviewed.json) |
| `npm.cmd test` | 22 passed, 11 files | 8.938 | [record](evidence/checks/desktop-final.json) |
| explicit test Python `-m pytest local-runtime/tests -q`, isolated temp/JUnit | 346 passed, 6 skipped, 2 warnings | 85.078 | [record](evidence/checks/runtime-final-explicit.json) |
| `npm.cmd run test:security` | passed | 9.641 | [record](evidence/checks/security-final.json) |
| `npm.cmd run verify:provenance` | passed | 1.734 | [record](evidence/checks/provenance-final.json) |
| explicit Python `-m ruff check local-runtime scripts/acceptance/issue-104 --select E9,F63,F7,F82` | passed | 0.281 | [record](evidence/checks/runtime-static-final.json) |
| explicit Python `scripts/verify-runtime-source.py` | passed | 0.250 | [record](evidence/checks/runtime-source-final.json) |
| `npm.cmd run dist:win` | Windows x64 NSIS built | 55.969 | [record](evidence/checks/dist-win-final.json) |
| `issue-101/install_lifecycle.ps1`, final installer | install, sandbox/UI/IPC, quit/close, uninstall preservation, reinstall passed | 37.516 | [record](evidence/checks/install-final.json) |
| Node 22 `issue-104/desktop.cjs`, dev-10 | T104-01 through 04 passed, exit 0 | 93.515 | [record](evidence/checks/functional-dev-10.json) |
| `issue-104/installed.ps1`, installed-11 | T104-01 through 04 passed, exit 0 | 90.765 | [record](evidence/checks/functional-installed-11.json) |
| WSL Python `issue-104/server_fixture.py`, dev-10 | actual Gateway/restart/cleanup, exit 0 | 124.762 | [record](evidence/checks/server-dev-10.json) |
| same Server fixture, installed-11 | actual Gateway/restart/cleanup, exit 0 | 147.444 | [record](evidence/checks/server-installed-11.json) |

The six Runtime skips are 2 unavailable symlink-creation cases, 2 non-Windows
secret-backend cases, POSIX process-group and mode-bit cases.
[JUnit](evidence/checks/runtime-final.xml.gz) retains exact reasons. Windows
junction protection executed. Both warnings are existing websockets close-code
deprecations. [Installation results](evidence/installation/lifecycle-results.json)
and [restoration](evidence/installation/profile-restoration.json) cover actual
startup/exit and preservation independently of authenticated functional flows.

Server full backend `make lint`, frontend `pnpm check`, and inventory passed on final source. Related serial/
nonserial tests passed 824 cases with 12 skips; the receipt-completion test
passed 10 repeated runs. Full standard, `pr-standard`, selected Real
E2E, document checks, graph audit and commit are pending. Final records must
replace this paragraph.

## Review and diagnostic attempts

[Independent Standards and Spec review](code-review.md) left 0 open findings.
Three Spec findings were fixed with failing-then-passing regressions: uncertain
stop retry, Run association after relayed approval, and history polling delaying
stop. Both reviewers checked the final UI/evidence follow-up, with 0 new findings.

[Attempt records](evidence/attempts) retain unsuccessful runs. Initial packaging
failed extracting macOS symlinks from a tool cache; final packaging used an
existing copied cache. Concurrent test/build work hit a loaded Runtime `.pyd`;
rebuilding and running both full suites in sequence passed. One command selected
a host Python without pytest; final commands use an explicit interpreter.
WSL became unresponsive; the user approved shutdown/restart, then work resumed.

An early real runner timed out by accepting only `result_not_verified`, omitting
the valid `cancel_requested` state. It now accepts both, and the UI labels the
latter unverified. Passing dev-04/dev-06/dev-08/installed-09 used superseded Server fingerprints
and are diagnostic only. Final dev-10/installed-11 use identical frozen source.
Server's first full standard attempt had environment/route-test failures; a later
backend run exposed an HTTP assertion racing WebSocket receipt processing.
The bounded completion synchronization retains the real handler and exact final
assertions. A related serial migration test also needed its ancestry updated.
Both fixes affect tests only; all production hashes match the prior candidate.
Server formatting fixes preserved the AST and preceded fresh functional runs.
The Server gate report retains failed attempts and the complete final rerun.

## Platform scope

Real Win7 remains `unexecuted`, owner Neowyh,
[#131](https://github.com/Orbit-Crew/iDeer/issues/131). Pending checks include
installation/startup/exit, Electron 22, bundled Python/cryptography, Windows
file-handle protections, cancellation, persistent task identity, and receipt
recovery across Runtime/Desktop/Server restarts. Modern Windows results do not
claim Win7 compatibility or linz retirement.
