# Issue 108 acceptance

Latest result: [installation timeout resolution and re-acceptance](timeout-resolution-20261026.md)
reproduces the mixed-time drain snapshot, fixes it conservatively, and records
the final clean installer passing online/offline update, real receipt replay
and installed failure blockers. The original failed attempts remain unchanged.

Current follow-up: [2026-10-26 supplement](supplement-20261026.md) records a new
installed candidate, the drain-refusal fix, separate online/offline installation
and real pending-receipt replay, plus installed storage/unknown-effect blockers.
Those final runs passed. The intermediate maintenance wait timeout was still
unexplained at that checkpoint; the newer resolution above records the controlled
reproduction and fix. The C8 record below remains
historical evidence for its original candidate, not this new installer.

[iDeer #108](https://github.com/Orbit-Crew/iDeer/issues/108) turns the verified
pending update of #107 into the single drain-and-install entry: explicit
confirmation, stop admitting new tasks, wait for in-flight terminal states
(timeouts are never treated as drained), verify durable local records, stop
the owned Runtime, apply the staged payload, and restart. Prerequisites #104
(closed 2026-10-23) and #107 (closed 2026-10-24, PR #12) verified.

Execution date: 2026-10-24, Asia/Shanghai. Automated execution only.

## Candidate and environment

Desktop branch `feat/issue-108` from develop `10862482e85c7cb7c4e4b4c4d35f6c01003ac398`.
Windows 11 Pro 10.0.26300 x64; Node 22.14.0; test Python 3.12.8; bundled
Runtime Python 3.12.10; Electron 22.3.27.

## What was delivered

- Runtime (`local-runtime/core/transport.py`, `desktop.py`): an install-drain
  control channel (`{"type":"install-drain","action":"begin|abort"}`, identity-
  and workspace-scope-bound). While draining, every newly dispatched task is
  refused with `UPDATE_DRAINING` before any claim, so the task identity is not
  consumed and nothing executes; in-flight tasks run to their terminal state.
  The status frame now carries `installDrain` and `activeTasks`.
- Electron (`src/main/installer.ts`): the coordinator. Confirmation is a
  dedicated dialog naming the target combination, file and deletion counts,
  and the drain semantics. The drain loop polls the Runtime status with a 90 s
  deadline; a deadline expiry or a storage latch aborts the drain and refuses
  the install with a fixed category (`blocked`), never faking a drained queue.
  After the drained queue and durable records are facts, `kind=patch` applies
  the staged payload (per-file SHA-256 before any copy, target paths bounded
  to the program directory, bounded deletions) and `kind=full` launches the
  user-confirmed full installer, then stops the owned process. A dev checkout
  refuses patch application (`UPDATE_PACKAGED_ONLY`).
- One user entry: `desktop:updates:install` (main-frame-gated) wired through
  the existing UpdatePanel button; the renderer receives only the outcome.

## Scenario results

| Scenario | Evidence | Result |
| --- | --- | --- |
| T108-01 (confirm, block new tasks, wait for terminals) | `test_install_drain.py`: a completed write precedes draining; the during-drain dispatch is refused `UPDATE_DRAINING` without consuming the task identity or writing bytes; abort restores admission and a later write completes. `test/install-coordinator.test.ts`: install only after `confirm`; drain-begin precedes apply; settled stop follows | passed |
| T108-02 (uncertain write effect, unreliable records, unstoppable process) | coordinator tests: drain timeout aborts and blocks with "did not reach a terminal state"; `receiptStorageError` blocks with "could not be saved durably"; neither installs nor fakes success | passed |
| T108-03 (no Server-confirmed receipts required; unconfirmed records kept) | the drain decision reads only the local ledger latch (`receiptStorageError`), never Server acknowledgment; unconfirmed rows are untouched by the refusal paths (no storage writes on any blocked path) | passed |
| T108-04 (real install + restart on modern Windows) | originally staged incomplete; now passed on the installed 0.2.0 candidate — see the re-verification section below | passed (re-verified) |

## Executed commands

| Command | Result |
| --- | --- |
| `npm.cmd run typecheck` | passed |
| `npm.cmd test` | 37 passed, 14 files (31 baseline + 6 new) |
| `npm.cmd run test:security` | passed (child_process boundary now allows the installer entry; IPC boundary includes `desktop:updates:install`) |
| pytest `local-runtime/tests -q` | 367 passed, 6 skipped (365 baseline + 2 new) |
| `ruff check local-runtime --select E9,F63,F7,F82` | passed |
| `npm.cmd run verify:provenance` / `scripts/verify-runtime-source.py` | passed |

## Dependencies and platform scope

The controlled hosting of full installers and patch payloads is a
Server/deployment workflow item (issue 107 report); the local offline-import
path is fully functional against a staged manifest+payload. Real Win7 remains
`unexecuted` under [#131](https://github.com/Orbit-Crew/iDeer/issues/131).

## Final-candidate installed re-verification (0.2.0, passed)

The single drain-and-install entry was re-run end to end on the installed
0.2.0 package against the real Gateway fixture (run C8, expectation
`updated`): pairing and workspace selection on the installed candidate, the
signed patch staged offline through the real file dialog, the confirm dialog
driving drain → verified graceful stop → out-of-process maintenance handoff,
the helper applying the patch with hash verification, the real relaunch
answering the `ideer-update-health-v1` echo, the receipt ledger byte-identical
across the whole installation, and the updated app writing its own
window/renderer/IPC usability record before the result was committed. Standalone installed offline coverage additionally verified staging, cancel
preservation and the `UPDATE_INSTALL_BUSY` concurrent-restart refusal.
Binding and evidence:
[final-candidate-binding.md](../final-candidate-binding.md),
[evidence/installed-updated-result.json](evidence/installed-updated-result.json).
Real Win7 remains `unexecuted` under [#131](https://github.com/Orbit-Crew/iDeer/issues/131).
