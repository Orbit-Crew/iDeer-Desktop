# Issue #101 acceptance

[Issue #101](https://github.com/Orbit-Crew/iDeer/issues/101) now has durable, identity-bound execution receipts and metadata-only recovery. T101-01 through T101-05 passed against the installed Desktop, bundled Windows Runtime and real isolated Server. Source fingerprints bind the tested candidates. The historical local Server PR lane failure remains in the evidence. GitHub delivery gates and the later test-only correction are recorded below.

## Candidate and environment

Executed 2026-10-21, Asia/Shanghai, by Codex. Prerequisite [#100](https://github.com/Orbit-Crew/iDeer/issues/100) was verified closed/completed through GitHub before implementation. The user confirmed the Runtime receipt storage/replay, Desktop history/cleanup IPC and Server acknowledgment API test boundaries.

| Item | Binding |
| --- | --- |
| Desktop branch / review base | `feat/issue-101`; `develop` pinned at `3b21dbdc68fdf82d7288ce9edd0dfc1689b18361` |
| Server branch / base | `feat/issue-101`; fetched develop `fb5ded4d37587d1c70b067087cf20bf444a18b3d` |
| Server commit | `2929de002b9823f3aa2bc700b830de34f9300cec` |
| Desktop product/test source SHA-256 | `5ed8a70a2996d0bd1a81f2c2d39bce217a873f4ebc922920beb87f6a89da0828` |
| Server product/test source SHA-256 | `8172a8292287d7aee1dd917cfffff459fe065f114b0e5ba3cb4f549c1f14f6cf` |
| Installer | `ideer-desktop-0.1.0-windows-x64-setup.exe` |
| Installer SHA-256 | `b3ab7667425091a7be032c4d5f57306fd02a18f81d0c1f6d89f739048e5f3e76` |
| Installed/candidate app.asar SHA-256 | `7489ddb6a554ec9e4c8b2e5ab574b02a965f078badb4019a924cd0c155f880c8` |
| Windows | Windows 11, `10.0.26300`, AMD64 |
| Desktop toolchain | Node `22.23.3`, npm `10.9.9`, Electron `22.3.27`, TypeScript `5.9.3` |
| Runtime | Bundled Python `3.12.10`, cryptography `43.0.3`, cffi `1.17.1`, websockets `13.1`; test Python `3.12.8` |
| Server | WSL Ubuntu, kernel `5.15.167.4`; Python `3.12.3`, Node `22.23.2`, pnpm `10.26.2`, uv `0.12.9`; locked dependencies |

[Source binding](evidence/desktop/desktop-source-binding.json.gz), [package hashes](evidence/desktop/package-hashes.json), [dependency locks](evidence/desktop/lock-hashes.json) and [environment](evidence/desktop/environment.json) retain exact inputs. Fingerprints cover product/test/build inputs and exclude acceptance scripts/generated reports to avoid self-referential hashes. No package lock changed. Existing dirty Server workspaces were untouched.

## Behavior and scenarios

The Runtime commits admission before execution and retains an uncertain outcome if completion cannot be saved. Reconnect negotiates signed metadata uploads under the original server/user/device/key binding. Server acknowledgment is durable and idempotent, independent of terminal Run state. History, counts, task summaries and cleanup use the current original binding. Manual confirmed cleanup leaves an immutable tombstone. No automatic expiry, record-count cap or write capability was added. Renderer generations discard stale status/history/cleanup replies.

The installed runner uses synthetic A/B accounts, a task-owned temporary file, real authentication/pairing, signed sockets, actual read tools, SQLite and native Desktop IPC. Only the model and explicit network/storage faults are fixture controlled. Dialogs are answered by automation; this is automated UI acceptance, not an independent human walkthrough. Server restart replaces its interpreter with `exec`, rebuilding broker and DB sessions while retaining its PID.

| Scenario | Fixed expectation and observed result | Status |
| --- | --- | --- |
| T101-01 | First read completes before archive confirmation. Restart Desktop/Runtime and Server interpreter; original receipt/task/Run/Tool Call/request/signature facts survive. Replay uploads metadata only. Execution audit count is exactly **1**. | passed |
| T101-02 | Lose ACK after archive commit, restart Server again, upload the same receipt. ACK ID and receipt ID/hash stay unchanged; terminal Run remains `success`; execution count remains 1. | passed |
| T101-03 | B gets 404 for A's archive and sees no A history/tasks. Invalid A retains pending facts locally; restored legal A confirms them. Confirmed cleanup preserves a tombstone. Pending/uncertain records remain protected. Runtime also rejects a stale cleanup confirmation before main status observes the identity change. | passed |
| T101-04 | 23 durable records exceed the 20-row page; older rows are reachable in the actual UI. Marker file hash stays unchanged. A separate process-reopen/privacy regression retains 27 receipts and proves full-body/credential markers are absent from SQLite. | passed |
| T101-05 | A SQLite admission trigger blocks new admission/execution. A completion trigger leaves an uncertain admitted row. After storage repair, two new reads succeed while ACK-only loss leaves two pending receipts. Confirmed cleanup protects those pending rows and the uncertain row. | passed |

Fixed marker SHA-256: `3dce537f1dc69be993eec4d74f279be641e7325d77595416265559e6acb36a44`. No real disk was filled. Fault triggers require the synthetic profile ownership marker. Thread creation and Run submission are single-attempt. Only read-only refresh may retry transport unavailability, at most three times, with recorded timing. The successful 128.016-second run made 27 refreshes, all successful on their first attempt.

[Structured scenarios](evidence/functional/result.json) and [acknowledgment events](evidence/functional/receipt-events.jsonl) retain synthetic identities and metadata, without credentials/full task output. The second complete run passed in 125.641 seconds. Its DOM-only screenshot gate requires three stable samples with authenticated/running status, loaded history and no status/history error. [Older-page screenshot](evidence/functional/receipt-history-older.png) shows 23 total records; [final screenshot](evidence/functional/receipt-history.png) shows 26 total, 2 pending, 1 uncertain and 23 cleanup markers. It uses the same installed asar and product sources.

## Commands and gates

Each command JSON records its exact argument vector, working directory, UTC start/end, duration and exit code. Logs and JUnit output are compressed evidence. Seconds below are measured with the wrapper's monotonic stopwatch; UTC clock corrections can make timestamp differences differ from that duration.

| Check | Result | Seconds |
| --- | --- | ---: |
| `npm.cmd run typecheck` | passed | 7.437 |
| `npm.cmd test` | 10 files, 16 tests passed | 11.766 |
| `npm.cmd run test:security` | passed | 4.235 |
| Full Desktop Runtime pytest suite | 278 passed, 6 platform skips, 1 websockets deprecation warning | 72.391 |
| Runtime syntax/undefined-name check | passed | 1.828 |
| `npm.cmd run verify:provenance` | passed | 1.375 |
| `npm.cmd run dist:win` | passed | 89.203 |
| Installed lifecycle/security smoke | install, asar identity, shortcuts, sandbox/IPC/CSP/navigation, UI quit/native close, uninstall/reinstall and synthetic data retention passed | 78.719 |
| Installed T101-01 through T101-05 | passed | 128.016 |
| Complete repeat with settled-UI screenshots | passed | 125.641 |
| Final Server receipt tests | 6 passed, 4 Alembic deprecation warnings | 11.333 |
| Server test inventory | passed | 24.275 |
| Server document checker | passed | 3.102 |
| Server upstream patch checker | passed | 0.538 |
| Protected Real E2E | 7 passed, 5 skipped | 272.483 |
| Isolated existing deadline test, with lane import roots | 1 passed | 12.698 |

Windows Runtime skips are existing POSIX/symlink/secret-store/key-mode cases. JUnit preserves their full reasons; they are not Win7 results.

Server `pr-standard` completed with parent `TEST_LANE_DURATION lane=pr-standard seconds=3652 status=1`:

| Sub-lane | Actual summary | Lane seconds/status |
| --- | --- | --- |
| local-runtime | 230 passed, 4 skipped | 37 / 0 |
| backend-standard | 26,861 passed, 237 skipped, **1 failed**, 1,080 warnings | 2286 / 1 |
| frontend-standard | 355 files, 10,565 tests passed | 949 / 0 |
| frontend-smoke | 35 passed | 360 / 0 |

The failed existing test is `test_runner_no_submit_is_terminal_and_pre_read_hang_has_finite_deadline`. Its synthetic quota-response subprocess exceeded a 0.05-second startup deadline and returned 124 instead of 1 under resource pressure. Neither that test nor its script changed for #101; matching baseline/current Git blobs are retained. A standalone rerun with `PYTHONPATH=.:tests` passed. The PR lane is still reported failed. A first isolated invocation lacked those import roots and failed collection; it is not counted as a test result.

The full lane began before the final nested-target correction. The final six-test receipt suite covers that localized correction, archive/broker/key persistence, migration and the actual API, including revocation on an already-open socket.

Protected Real E2E was selected. The five skipped cases require a real RAGFlow dataset, prepared Gate 7/8 evidence IDs/markers, or real model/RAGFlow credentials with `REAL_E2E_REAL_MODEL=1`. These cases remain unexecuted. No provider-backed behavior is claimed from the deterministic issue fixture.

Server static checks passed for all 16 changed Python files in 0.601 seconds. The final clean GitNexus 1.6.10 index completed in 330.141 seconds. Scope-all analysis, after staging new files, completed in 1.051 seconds: 18 files, 67 symbols, 20 indexed processes, `critical` risk, no partial/truncated output. [Full structured result](evidence/server/detect-changes-result.json) is unsliced. Earlier HIGH/CRITICAL warnings for `send_task` and `get_device_broker` were retained before editing. Dynamic websocket/constructor callers and the new target helper's caller were checked in source where indexed impact was UNKNOWN.

The index logs retain global callable/flow enumeration caps and cross-language inference warnings; missing graph edges are not evidence of safety. Three unchanged generated/vendor files above 512 KB were skipped. The complete change-query result does not claim an exhaustive dynamic call graph. Authorization, migration, restart and replay tests provide separate behavioral evidence.

Server commit `2929de002b9823f3aa2bc700b830de34f9300cec` was local to the isolated checkout at the original evidence capture. Its [exact Git format-patch](evidence/server/server-delivery.patch.gz) is preserved. The later branch publication and delivery candidate are recorded below.

## Attempts, recovery and cleanup

- Initial Desktop tests depended on a missing ignored `artifacts/issue-99` parent. The fixture now uses OS temporary storage; the full suite then passed.
- Initial packaging could not extract unused Darwin symlinks without Windows symlink privilege. A version-matched Windows helper cache was reused, with hashes retained. Product build settings were unchanged.
- Legacy `powershell.exe` lacked `Get-FileHash` and stopped before modifying the installation. The successful lifecycle used PowerShell 7.
- First installed scenarios stopped at a read-only refresh transport timeout after 23 successful reads. [Canonical Run reconciliation](evidence/attempts/functional-first/run-reconciliation.json) found no extra fault Run/repeated mutation. Failure evidence remains; the fresh sequential run passed with no refresh retry.
- A preliminary Server lane was interrupted and is not acceptance evidence. First Real E2E timed out waiting 420 seconds for frontend startup while full tests competed for two WSL CPUs. The sequential rerun passed. Both runs' stopped readonly fixture resources were subsequently removed with strict path/owner checks.
- GitNexus 1.6.12 incremental indexing corrupted path strings. That result is not clean impact evidence. An earlier clean 1.6.10 rebuild succeeded. A later concurrent rebuild was canceled to relieve memory pressure; the final fresh sequential rebuild and change query passed.

Both successful lifecycle and scenario wrappers hash-restored the original Runtime's three files. The installed asar matched the candidate. All three synthetic Gateways exited, all six tracked Credential Manager entries per run were removed with zero failures, and their task-owned Linux databases/keys were deleted. Credentials, keys, profiles, databases, real user data and raw browser traces are excluded from committed evidence. [Cleanup proof](evidence/server/functional-fixture-cleanup.json) and [manifest](evidence/manifest.json) bind retained evidence files.

## Review and Windows 7

[Two-axis review](code-review.md): Standards 0 open findings; Spec 0 open findings. Rechecks resolved ownership isolation, immutable cleanup, nested logical-target/error metadata and renderer status races. Source review does not replace test-gate evidence.

Real Windows 7 validation remains **unexecuted** under [#131](https://github.com/Orbit-Crew/iDeer/issues/131), owner Neowyh. It covers persistence/restart, legal reconnect, account isolation, cleanup, storage faults and installer lifecycle. Dependencies include the Win7 Python/crypto distribution and existing Electron, Node 16 and process-ownership patches. Modern Windows results do not establish Win7 compatibility.

## Delivery follow-up

On 2026-10-21 both `feat/issue-101` branches were published as [Server PR #138](https://github.com/Orbit-Crew/iDeer/pull/138) and [Desktop PR #6](https://github.com/Orbit-Crew/iDeer-Desktop/pull/6). Desktop product/test candidate `c68816994789392fbf6d1f08b4c34c4654d98de7` passed both GitHub Linux and Windows jobs, including packaging and installed lifecycle checks, in [Desktop baseline run](https://github.com/Orbit-Crew/iDeer-Desktop/actions/runs/39609907789). This report follow-up changes documentation only; the installed product/test fingerprint above remains unchanged.

The first Server CI run passed all four backend standard shards, static checks, contracts, replay and Real E2E. Its [Migration Tests run](https://github.com/Orbit-Crew/iDeer/actions/runs/39609880295) failed one stale direct-parent assertion: the receipt head follows `desktop_login`, while the assertion still expected `rejoin_upstream_line`. Server follow-up commit `aa7bada13417e99ce7550c274bc3ffec2a6c435b` changes only `backend/tests/integration/persistence/test_migration_schema.py`. It verifies receipt → desktop_login → rejoin, keeps the old merge's two parents, and verifies ancestry back to that merge. The other migration tests remain intact. No product, dependency, migration or fixture file changed, so the installed cross-repository scenarios retain their original candidate binding.

The original assertion failure was reproduced before the correction. The corrected schema suite passed 8 tests in 15.10 seconds. The complete migration regression set passed 121 tests with 5 conditional skips in 83.18 seconds. Ruff, inventory, document/upstream/guidance checks passed. Independent incremental Standards and Spec reviews each found 0 issues. Complete change analysis reported 2 symbols in 1 file, low risk, 0 indexed affected processes, `partial=false`, `truncated=false`; source review separately checked pytest/CI invocation. The final Server product/test fingerprint is `f69b37971bd872b76be1d41f5791c30e1f287fb22790742cc2f13aa15244c367`; comparing its path/hash records with the original binding confirms that only the migration test changed.

Final Server candidate checks are recorded by [PR Standard](https://github.com/Orbit-Crew/iDeer/actions/runs/39611674453), [Migration Tests](https://github.com/Orbit-Crew/iDeer/actions/runs/39611674452), [Real E2E](https://github.com/Orbit-Crew/iDeer/actions/runs/39611674885), [Replay E2E](https://github.com/Orbit-Crew/iDeer/actions/runs/39611674575), and [Blocking IO](https://github.com/Orbit-Crew/iDeer/actions/runs/39611674482). Merge and issue closure remain conditional on their successful completion. The issue's delivery record retains the final merge/closure outcome; historical local and first-CI failures above are not rewritten as passes. Real Win7 remains unexecuted under #131.
