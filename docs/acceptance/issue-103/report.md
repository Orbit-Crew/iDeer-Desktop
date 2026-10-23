# Issue 103 acceptance

Specification: [iDeer #103](https://github.com/Orbit-Crew/iDeer/issues/103).
Prerequisite #102 verified closed/completed on 2026-10-23.
Desktop base: `0a26bdf`, branch `feat/issue-103` from `origin/develop`.
Server base: `207b3926f`, verified against `github/develop`. Its implementation
uses a separate WSL worktree on the same `feat/issue-103` branch name.

T103-01 through T103-04 passed on modern Windows on 2026-10-23, Asia/Shanghai,
in both the development application and the installed candidate. Each run
executed 17 real operations with 15 grouped scenario assertions. The complete
Server `pr-standard` gate also passed. Modern Windows acceptance is complete;
real Win7 remains deferred under #131 as recorded below.

The user confirmed tests at WorkspaceFileService, signed Runtime protocol,
Desktop chat approval UI, real Server-to-Runtime integration, authorization
settings and login/logout/revocation/credential rotation boundaries.

## Scenario contract registered before implementation

Synthetic identities A/B, devices D1/D2 and directories W1/W2. Independent
expected file constants are BEFORE, AFTER and NEW. Text limit stays 65,536
UTF-8 bytes; production approval timeout stays 300 seconds. No timing tolerance
applies to file bytes or hashes. Network/UI waits use bounded deadlines.

| Scenario | Executable entry | Expected observations | Status |
| --- | --- | --- | --- |
| T103-01 | `test_directory_grants.py`; `scripts/acceptance/issue-103/desktop.cjs` | Explicit local directory consent; existing/subdirectory/new writes; separate persistent grant reference and one-time basis; settings visibility | passed in both real runs |
| T103-02 | Workspace/signed protocol regressions and real Desktop fixture | Content changes allowed; outside/protected/junction/script requests denied; legacy consent not imported | passed in both real runs and protocol checks |
| T103-03 | `test_browser_login.py`; real Server/Desktop lifecycle fixture | Logout cancels pending; same binding restores; A/B and D1/D2 isolated; revoked/rebound identity invalid; credential rotation preserves grant | passed in both real runs |
| T103-04 | `test/grant-management.test.ts`; real Desktop and installation lifecycle | Selection/reopen revalidates; settings revoke prevents reuse; close truly exits | passed in both real runs and installation checks |

Existing product has no tray hiding entry. Native close exits the application;
tray hiding is not applicable. Real Win7 remains unexecuted under
[#131](https://github.com/Orbit-Crew/iDeer/issues/131), owner Neowyh. Its pending
checks cover installation, startup/exit, secure storage, directory consent,
identity lifecycle, native dependencies and file-handle protections.

## Candidate and environment

Desktop product/test/build source SHA-256:
`3a433a621b9082c134d7c32f5cf1ff6500c231f0be099aa293435c1e17621bb3`.
The [per-file binding](evidence/desktop/source-binding.json.gz) records the
uncommitted candidate over the base above. Committing those bytes does not
change the tested candidate. Acceptance scripts are hashed separately in both
functional result records.

Server product/test/build source SHA-256:
`cb2da64c47586adcf249ce0b56f6858b673f80189053e0261b1cdf6f3025a980`.
The fixture binds actual Server sources before READY. Server changes are strict
recognition of `approved` or `directory:<canonical lowercase UUID>` on live and
replayed completed writes. Original user/device/session, signed task, Run,
tool-call and request-hash validation remains mandatory. Server never uses a
grant reference to authorize execution or re-run a task.

Windows 11 Pro 10.0.26300 x64; Node 22.23.3; test Python 3.12.8; bundled Python
3.12.10. Server uses isolated WSL Ubuntu/Linux x64, Python 3.12.3, Node 22.23.2
and locked pnpm 10.26.2. See the [environment](evidence/environment.json) and
[dependency-lock hashes](evidence/desktop/lock-hashes.json).

Installer SHA-256:
`fda4a9266eac7853d06529243014b443e20b8d45de87332062d7ad84e388dca9`.
[Package hashes](evidence/desktop/package-hashes.json) verify the installed ASAR
equals the candidate ASAR, and all 26 installed Runtime source files equal the
tested source. Installed path: `D:\software\iDeer Desktop\ideer-desktop`.

## Executed Desktop gates

Each command record contains the exact working directory, UTC start/end,
elapsed time and exit code. Adjacent `.log.gz` files retain complete output.
Every selected command exited 0.

| Command | Result | Seconds | Record |
| --- | --- | ---: | --- |
| `npm.cmd run typecheck` | passed | 7.516 | [command](evidence/desktop/checks/typecheck-reviewed.json) |
| `npm.cmd test` | 20 tests / 11 files passed | 12.532 | [command](evidence/desktop/checks/desktop-tests-reviewed.json) |
| `npm.cmd run test:security` | passed | 2.609 | [command](evidence/desktop/checks/security.json) |
| `npm.cmd run verify:provenance` | passed | 0.672 | [command](evidence/desktop/checks/provenance.json) |
| `python -m ruff check local-runtime scripts/acceptance/issue-103 --select E9,F63,F7,F82` using the explicit test interpreter | passed | 0.344 | [command](evidence/desktop/checks/runtime-static-final.json) |
| `python scripts/verify-runtime-source.py` | passed | 0.140 | [command](evidence/desktop/checks/runtime-source-final.json) |
| `python -m pytest local-runtime/tests -q` with isolated base temp and JUnit | 338 passed, 6 skipped, 2 dependency warnings | 78.328 | [command](evidence/desktop/checks/runtime-tests-final.json) |
| `npm.cmd run dist:win` | Windows x64 NSIS candidate built | 55.812 | [command](evidence/desktop/checks/dist-win.json) |
| `scripts/acceptance/issue-101/install_lifecycle.ps1` with this installer | installed UI/security, quit/close, uninstall data retention and reinstall passed | 39.016 | [command](evidence/desktop/checks/install-lifecycle-final.json) |

The six Runtime skips are two unavailable symlink-creation cases, two
non-Windows secret-backend cases and two POSIX process/mode-bit cases. Their
exact reasons are in the [JUnit record](evidence/desktop/checks/runtime-tests-final.xml.gz).
The required Windows junction escape was exercised and rejected in both real runs.
The [installation result](evidence/installation/lifecycle-results.json) and
[profile restoration](evidence/installation/profile-restoration.json) record
retained user data and successful cleanup. No Win7 result is inferred.

## Real cross-repository results

The fixture uses the actual Gateway, database, signed broker, Electron UI and
bundled Windows Runtime. Only the model is deterministic. Directory and chat
approval, revoke, logout and detach are real Desktop clicks. Browser login
confirmation uses the synthetic owner's authenticated public HTTP API. No
external model request or separate human sign-off is claimed.

| Run | Result | Seconds | Evidence |
| --- | --- | ---: | --- |
| Development | 17 operations; all 4 scenarios passed | 75.265 | [command](evidence/desktop/checks/functional-dev-11.json), [results](evidence/development/result.json.gz) |
| Installed candidate | 17 operations; all 4 scenarios passed | 73.344 | [command](evidence/desktop/checks/functional-installed-12.json), [results](evidence/installed/result.json.gz) |

T103-01 checks existing and changed content, an existing child file, a new child
file and a new UTF-8 file with mixed newline characters. Each matching write
uses the same explicit directory grant and its exact resulting file hash;
subsequent writes show no local approval. Settings shows the normalized scope,
operation, owner/device, timestamp and grant ID. The
[installed approval card](evidence/installed/explicit-directory-approval.png)
shows the physical directory and distinct one-time, persistent and deny choices.

T103-02 preserves original bytes on traversal (`INVALID_PATH`), protected
`.git/config` (`PROTECTED_PATH`), an actual junction (`OUTSIDE_ALLOWED_ROOTS`)
and local DENY (`LOCAL_POLICY_DENIED`). Independent signed Runtime tests show
directory consent cannot announce or execute `local.python`; legacy single-file
or capability approval does not create a directory grant.

T103-03 observes logout during a pending write, unchanged bytes, hidden grants
and receipts after signed-out reopening, valid same-device relogin and legal
credential rotation with the same grant ID. Server revoke ends the old socket;
reopening cannot authenticate the revoked device. Detach/new pairing into B
has a new binding, no inherited grant and a fresh approval that is rejected.
Each run removed six remaining synthetic references and verified nine already
retired by logout/rotation. Original installed Runtime files were restored with
identical hashes in the [restoration record](evidence/installed/profile-restoration.json).

T103-04 revokes the grant through settings, then verifies a new write requires
one-time approval and records `approved`. Switching W1 to W2 during another
pending approval leaves the original file unchanged and records zero executions.
The disconnected Server Run can remain `RESULT_UNCERTAIN`; this is retained
alongside the actual file/ledger observations and is not rewritten as a success.
Native exit and reopening are separately covered. Tray hiding is not applicable.

## Server gates and review

Focused signed broker/archive/login/API regression: 74 passed. Changed-file
Ruff, inventory, final document and upstream-patch checks passed. The complete
`pr-standard` run passed with the following child lanes. Full output, metadata,
environment and dependency fingerprints are in the [Server evidence](evidence/server/selected-lanes.json).

| Lane | Result | Seconds |
| --- | --- | ---: |
| `local-runtime` | 230 passed, 4 skipped, 1 warning in 9.48s | 17 |
| `backend-standard` | 26920 passed, 237 skipped, 1079 warnings in 1491.13s (0:24:51) | 1674 |
| `frontend-standard` | Rstest 1270 passed; Vitest 10565 passed | 481 |
| `frontend-smoke` | 35 passed (1.5m) | 105 |
| `pr-standard` | passed, exit 0 | 2285 |

Earlier standard-lane attempts are recorded separately. One used pnpm 11, one exposed TEST_PNPM_BIN to resolver tests, and one lacked uv on PATH. The selected run uses a PATH wrapper for locked pnpm 10.26.2, no TEST_PNPM_BIN, and the installed uv. All 17 resolver regressions pass. An earlier smoke run had three menu-action timeouts; the unchanged three tests passed under the production build, and the selected full smoke lane passed. No assertion or timeout was relaxed. Pinned GitNexus 1.6.10 restored the graph and FTS after the default CLI version drifted.

The final GitNexus analysis includes all staged changes. Its complete symbol
mapping, pre-edit impacts and graph doctor result are retained in Server evidence.
The CI selector chooses governance, backend-standard and static checks. The
explicit protected-path Real E2E selector is false for these device-control
paths; the ticket's real cross-repository acceptance above was still executed.

Independent [two-axis reviews](code-review.md) found zero Desktop/Server
documented-standard or spec violations. Desktop had one non-blocking suggestion
to type the existing dictionary/positional binding format. Both stop-ordering
and signed-out-history changes received follow-up review.

## Historical attempts and evidence integrity

[Historical results](evidence/attempts/history.json) retain earlier failures
separately. They include the pre-fix pending-device restore, old Server receipt
basis, wrong traversal error expectation, a revoke observation timeout that did
not recur in isolated IPC or fresh real runs, disconnect-result expectation,
already-retired test credential cleanup, and a WSL/HTTP startup timeout.
None substitutes for the selected passing runs. Earlier suite fixture failures
were fixed by providing authenticated status/device responses; original
assertions and migration coverage were retained. The installer smoke allowlist
was updated for the new explicit management IPC.

No ready manifests, settings files, credential ledgers or private signing
material are committed. The [evidence manifest](evidence/manifest.json) binds
selected logs, results, screenshots, hashes and historical summaries.
