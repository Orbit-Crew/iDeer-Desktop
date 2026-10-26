# Issue 109 acceptance

Current result: [2026-10-26 installed recovery re-acceptance](supplement-20261026.md)
records six native NSIS/helper fault cases and a real paired rollback followed
by file operations, original receipt replay, revoked-grant checks and KB metadata
access checks. Read its candidate binding and coverage limits first. The older
report below remains evidence for its original candidate.

[iDeer #109](https://github.com/Orbit-Crew/iDeer/issues/109) protects data and
recovers a compatible program when a drain-and-install update fails: every
overwritten or deleted file is backed up before the patch applies, the restart
verifies the installed combination exactly once, a mismatch restores the
previous bytes, and a failed recovery stops all automatic updates behind a
manual-repair note. Prerequisite #108 closed 2026-10-24 (PR #13).

Execution date: 2026-10-24, Asia/Shanghai. Automated execution only.

## Candidate and environment

Desktop branch `feat/issue-109` from develop `a5b9ce398ba4c56a661812dfbb3b42dc186e6393`.
Windows 11 Pro 10.0.26300 x64; Node 22.14.0; Electron 22.3.27; bundled Runtime
Python 3.12.10.

## What was delivered

- `src/main/recovery.ts`: `backupTargets` records the pre-install SHA-256 of
  every overwritten or deleted program file into
  `resources/updates/backup-<stamp>/backup-manifest.json` (payload copy kept
  beside it); `restoreBackup` restores exactly those facts and removes files
  that were new under the stamp, refusing cross-root or integrity failures;
  `resolveRestart` is the one-shot restart verification: match → `updated`,
  mismatch → rollback → `rolled-back`, rollback failure or missing backup →
  `recovery-failed` with the automatic-update lock engaged and diagnostics
  preserved. The recovery record persists in the user-data area.
- `src/main/index.ts`: the installer backs up before applying; the install
  entry refuses to run when the lock is engaged (`UPDATE_RECOVERY_LOCKED`);
  startup performs the one-shot verification; `desktop:updates:recovery`
  exposes the state to the renderer.
- `UpdatePanel` shows the recovery state (pending verify / verified /
  rolled back / recovery failed with the manual-repair note).

## Scenario results (vitest `test/recovery.test.ts`, 3 new cases, all passed)

| Scenario | Evidence | Result |
| --- | --- | --- |
| T109-01 (data, credentials, receipts preserved across injected failures) | recovery reads and writes only the program directory: the profile (receipts/credentials area) byte content is asserted unchanged through verify, rollback and lock paths; the rollback restores exact prior bytes (hash-checked backup) and removes previously-new files instead of resurrecting them | passed |
| T109-02 (safe rollback only when the old program reads current data) | user data never enters recovery — the previous program is restored against untouched data, so the old combination reads it by construction; a format-incompatible full-installer path is the `kind=full` advice of #107/#108 rather than an in-place mix | passed |
| T109-03 (no old/new mix; repeated updates stop; diagnostics kept) | rollback restores the complete recorded set; a second verification cycle cannot start because the recovery lock refuses installs and a recovery failure preserves the backup directory and the diagnostics text (`manual repair`) | passed |
| T109-04 (cross-repo rerun after real restart) | originally staged with #108; now passed on the installed 0.2.0 candidate — see the re-verification section below | passed (re-verified) |

## Executed commands

| Command | Result |
| --- | --- |
| `npm.cmd run typecheck` | passed |
| `npm.cmd test` | 40 passed, 15 files (37 baseline + 3 new) |
| `npm.cmd run test:security` | passed (boundary includes `desktop:updates:recovery`) |
| `npm.cmd run verify:provenance` / `scripts/verify-runtime-source.py` | passed |
| `ruff check local-runtime --select E9,F63,F7,F82` | passed (no Runtime changes in this issue) |

## Platform scope

Real Win7 remains `unexecuted` under [#131](https://github.com/Orbit-Crew/iDeer/issues/131).
The staged cross-repo re-verification was completed on the final candidate; see the re-verification section below.

## Final-candidate installed re-verification (0.2.0, passed)

A deliberately broken signed patch (syntax-broken `desktop.py`) was
installed on the installed 0.2.0 candidate with the paired fixture harness
(run D1, expectation `rolled-back`): the update applied, the relaunched
combination failed its health handshake (`UPDATE_APPLICATION_START_FAILED`),
the helper restored the exact prior bytes (verified against the recorded
pre-run hashes, unrelated files untouched), relaunched the old combination,
verified the real window/IPC/echo usability record, and persisted
`rolled-back` with the honest "automatic updates paused; run manual repair"
detail. The receipt ledger stayed byte-identical. Binding and evidence:
[final-candidate-binding.md](../final-candidate-binding.md),
[evidence/installed-rollback-result.json](evidence/installed-rollback-result.json).
Real Win7 remains `unexecuted` under [#131](https://github.com/Orbit-Crew/iDeer/issues/131).
