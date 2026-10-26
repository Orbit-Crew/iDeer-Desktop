# Issue 108 acceptance supplement, 2026-10-26

Historical checkpoint. See [the subsequent timeout resolution](timeout-resolution-20261026.md)
for the reproduced failure path, conservative fix and final clean-package
re-acceptance. The unresolved wording below describes the state of this earlier
checkpoint; its raw failed records are preserved.

This supplements the earlier C8 record. The final online, offline and installed
blocker runs below passed on the new candidate. Their immutable command records
and raw results are in [evidence/supplement-20261026](evidence/supplement-20261026).
An intermediate installation wait timeout is also retained and remains
unexplained; passing final runs do not establish that intermittent installation
failures are absent. No GitHub issue status or release approval was changed.

## Candidate and environment

- Desktop branch `codex/issue-108-acceptance`, based on
  `7fe3877dc88fe8f156bb8e038a004ffa91fee2d2`, with the reviewed working-tree
  transport fix and regression. Exact product/test source fingerprint:
  `07069fdcb33df8885b8439f3abbf0cd5787e8a5b6559c690d21f4ae4afd1736a`.
- New installer `ideer-desktop-0.2.0-windows-x64-setup.exe`, 92,394,899 bytes,
  SHA-256 `9db500c525366ecf6c093b51bf0d539942d36327066fdcce77fff7fef7ab9374`.
  This is a new #108 candidate, not the earlier `d89450a0…` #111 artifact.
- Windows 11 Pro 10.0.26300 x64, Node 22.14.0, Electron 22.3.27,
  Runtime Python 3.12.10, test Python 3.12.14. Package/dependency locks, source
  hashes, installer sidecar and key binding are in `candidate-binding.json`.
- The same isolated test Ed25519 key binds the installer and repair release.
  Public-key fingerprint `2836a6c72360fca73c8bbf737a2d789224fdaa4ebf964ec6f53e5676ea7f49db`.
  The private key remains outside the repository and package.
- Real Server Gateway from clean Server PR146 head
  `99cd9b8961be2a9ee079a06b9dede0f0dd3c86bf`, with the original synthetic
  `issue-102/server_fixture.py`. Server source binding is carried by each run.
  `SERVER_RELEASE_VERSION=591f80c-runtime-compat-20261025`.
  The online run uses the formal `/updates/` router and a reviewed, isolated
  `UPDATES_CONTROLLED_DIR`, not a mocked update endpoint. The compatibility
  document is unpublished in this fixture; its 404s preserve supported legacy
  protocol-1 behavior and are not failed patch downloads.
- Each run uses a fresh Server database, synthetic A/B identities, fresh
  `--user-data-dir`, temporary workspace and NSIS-installed program. The blockers
  run reuses the now-updated program from online-c with a new identity/profile.
  No ordinary user profile is loaded. All execution is automated; no human
  sign-off or external model call is claimed.

## Defect found and fixed

The first installed online attempt, `online-a`, failed because a task arriving
during drain was refused before admission with an error receipt containing an
empty Run/capability and the hash of an empty request. The real Server correctly
rejected that receipt as mismatched; the conversation showed `RESULT_UNCERTAIN`
instead of the definite refusal. No file effect occurred.

`local-runtime/core/transport.py` now passes the original verified payload and
operation to the drain refusal receipt. It still does not claim the new task
identity or execute it. Two regression cases first failed on the missing Run
binding, then passed with the fix; they assert Run, capability, request/payload
hashes, denial status and the existing no-claim behavior. The final installed
online and offline runs both observe `UPDATE_DRAINING` in the actual Turn.

## Scenario results

| Scenario | Executed evidence | Result |
| --- | --- | --- |
| T108-01 | `online-c` and `offline-a`: actual update UI stages the release; cancel during an admitted write preserves program bytes and pending stage; confirm starts drain; a new real Server dispatch is refused with `UPDATE_DRAINING`, zero executions and no local receipt admission; the original approved write completes once before maintenance. Coordinator contract also verifies the drain deadline blocks rather than pretending the queue is empty. | passed |
| T108-02 | `blockers-a`: real SQLite completion failure after a real file effect latches storage failure and blocks installation; a later durable read clears only that latch, the unresolved original write still blocks a second install. Program hashes and pending stage remain unchanged. Separately, the coordinator's process-stop failure injection returns blocked without replacement, and the full Windows test baseline covers the native process inventory/guard. The installed driver does not simulate an unkillable OS process. | passed for the listed installed storage/unknown-effect and process-stop contract coverage |
| T108-03 | `online-c` and `offline-a`: lose acknowledgment of a real completed write, install while its original receipt is still pending, verify the same receipt ID/hash/request/owner/device/Run/Task after restart, reconnect the updated Runtime, observe matching upload and Server ACK, verify confirmed state and exact file hash, one original dispatch and one execution. No receipt is seeded directly. | passed |
| T108-04 | `online-c`: actual UI downloads manifest, signature and changed tray.py through formal Server routes, all HTTP 200. `offline-a`: actual import UI reads the same signed release locally. Both confirm through the single installation entry, perform real maintenance, replace tray.py with its declared SHA-256, preserve app.asar, and verify actual Desktop window/renderer/IPC and Runtime echo after restart. | passed |

The final result JSONs contain separate scenario outcomes; blockers-a is scoped
only to T108-02, while the online/offline drivers cover T108-01/03/04. No broad
top-level success is used as a substitute for that scenario mapping.

## Commands, exit codes and durations

All commands run from the Desktop checkout. Absolute interpreter and executable
paths, arguments, UTC timestamps, exit codes and durations are retained in
the `*-command.json` records. Environment inputs and replay steps are described
in `scripts/acceptance/issue-108/README.md` and `candidate-binding.json`.

| Command / run | Result | Duration |
| --- | --- | --- |
| `npm.cmd run typecheck` | exit 0 | 7.641 s |
| `npm.cmd test -- --no-cache --reporter=json --outputFile=…` | exit 0; 94 tests, 21 files, including security and 9 coordinator tests | 22.656 s |
| `python -m pytest local-runtime/tests -q --basetemp <fresh TEMP directory>` | exit 0; 397 passed, 6 skipped, 2 warnings | 123.344 s |
| `python -m ruff check local-runtime --select E9,F63,F7,F82` | exit 0 | 0.265 s |
| `python scripts/verify-runtime-source.py` | exit 0 | 0.156 s |
| `node scripts/verify-provenance.cjs` | exit 0 | 0.203 s |
| `npm.cmd run dist:win` | exit 0; new installer and trust sidecar above | 84.485 s |
| `node scripts/acceptance/issue-108/acceptance.cjs <online-c>` | exit 0; online, 8 recorded cases | 36.562 s |
| `node scripts/acceptance/issue-108/acceptance.cjs <offline-a>` | exit 0; offline, 8 recorded cases | 36.032 s |
| `node scripts/acceptance/issue-108/blockers.cjs <blockers-a>` | exit 0; 2 installed fault cases | 20.922 s |

The warnings remain in the compressed full pytest log. A focused `-rs` rerun
records all six skip reasons in [`skip-reasons.log.gz`](evidence/supplement-20261026/skip-reasons.log.gz): two unavailable Windows
symlink cases and four POSIX/non-Windows-only cases. They are not counted as
passes. No Server product source changed in this task.
The real cross-repo runs bind the unchanged Server tree; this task does not
claim a new Server pr-standard or release approval run.

## Failed attempts and remaining limits

- `online-a`: exit 1, 19.782 s, definite drain refusal became uncertain because
  of the receipt mismatch above. This has a failing regression and a fix.
- `online-b`: exit 1, 264.281 s, maintenance outcome wait timed out after the
  in-flight write completed. It used the repaired installer but the earlier
  driver, which did not retain actual install UI/state when waiting. No
  maintenance journal was produced. Its result and command remain archived;
  its exact cause is not established and it is not relabeled as passed.
  The driver was then changed to fail promptly on actual blocked/failed
  installation UI and to retain Runtime/UI diagnostics. Final online-c and
  offline-a passed on that diagnostic entry point and the same product bytes.
- Initial baseline runs encountered missing Runtime/NSIS cache, denied loopback
  access, and correctly rejected workspace directories under `.codex`. After
  assembling the locked Runtime, restoring the cached NSIS tool, allowing local
  socket tests and using fresh TEMP workspaces, the full baseline above passed.
  No path protection, assertion or refusal was weakened.
- Cleanup records show final Gateway processes exited and six synthetic
  credential references per run were removed. Updated app processes were
  cleaned up by their own recorded PIDs after task/receipt verification.
- This closes the two previously identified evidence gaps for online install
  and real receipt replay. It does not constitute an assertion of zero
  intermittent failures, a human release sign-off, or fresh #109/#111 acceptance.
  Real Win7 remains `unexecuted`, with Neowyh responsible under
  [#131](https://github.com/Orbit-Crew/iDeer/issues/131) for its update/compatibility
  validation.
