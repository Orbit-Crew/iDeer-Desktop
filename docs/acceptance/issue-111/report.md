# Issue 111 acceptance

[iDeer #111](https://github.com/Orbit-Crew/iDeer/issues/111) is the phase-one
final-package cross-repo acceptance. Final state: the installed-package full
matrix, the paired installed update/rollback scenarios, the installation
lifecycle and both repositories' gates are green on the final 0.2.0
candidate; the earlier 0.1.0-era records are retained below as history.

Candidate, environment, key binding and the full run map are in
[final-candidate-binding.md](../final-candidate-binding.md).

## Final candidate

Desktop branch `codex/complete-issues-105-110`, HEAD `a32d7c9` (13
ticket-grouped commits on develop `dc104ea`, two-pass code review recorded).
Final installer `ideer-desktop-0.2.0-windows-x64-setup.exe` (92,394,783
bytes), SHA-256
`d89450a0b01ad8f69f58086ad44068d09dceac575da75f29b4a2339f4ae7e4e0`,
installed per-user at `D:\software\iDeer Desktop\ideer-desktop`; the
packaged trust anchor, the installer trust sidecar, the signed patch
releases and the Server trust file bind the same isolated test key
(fingerprint `2836a6c7…7f49db`). Server: real Gateway fixture from the
Server candidate `591f80cf3` with `SERVER_RELEASE_VERSION=
591f80c-runtime-compat-20261025`. Windows 11 Pro 10.0.26300 x64;
Electron 22.3.27; bundled Runtime Python 3.12.10. Every run used the
standard `--user-data-dir` isolation below its own fresh state directory;
the real user profile was never read, moved or replaced.

Gates: Desktop typecheck 0, vitest 21 files / 94 tests passed, pytest 389
passed / 6 skipped, provenance verified, ruff clean on changed files; PR CI
`static-and-contract` and `windows-package` green on the final PR; Server
gates for dependency PRs #142–#145 green (see the 0.1.0-era record below
and the Server-side report).

Prerequisites verified delivered: #106 (Desktop PR #11, Server PR #142 merged
`6a819f3`), #109 (PR #14), #110 (Desktop PR #15, Server PR #145 merged
`591f80c`), plus the Server-side artifact endpoint (#105, PR #143 merged
`432b609`) and the controlled address (#107, PR #144 merged `169c175`).

Execution dates: 2026-10-24 (0.1.0-era phase) and 2026-10-25/26 (final
0.2.0 candidate), Asia/Shanghai. Automated execution only.

## T111-01/02/03 — installed-package full matrix (passed, run E1)

`scripts/acceptance/issue-111/desktop.cjs` with `DESKTOP_EXECUTABLE` pointed
at the installed 0.2.0 exe against the real restartable Gateway — 14 cases,
all passed; result JSON
[evidence/installed-matrix-result.json](evidence/installed-matrix-result.json),
full-page screenshot [evidence/installed-matrix.png](evidence/installed-matrix.png).

- T111-01: pairing, workspace authorization, a streamed turn to a terminal
  Run, Runtime restart, and the original Thread reopened (`2` cases).
- T111-02: overwrite with per-approval, refusal, request-hash mismatch
  (`CONSENT_MISMATCH`), the directory grant removing later approval cards,
  and the three unsafe-path refusals (`8` cases, all side-effect-exact).
- T111-03: a committed first write kept while stopping the Turn awaiting the
  second approval (interrupted, `0` executions), the explicit upload against
  the **live Server artifact endpoint** with `uploaded_at` recorded, and the
  signed read proof (`4` cases).

## T111-04 — gates and records (passed)

Both repositories' gates listed above; the gate record travels in this
report; final local history/audit integrity asserted inside run E1.

## Installation lifecycle (passed)

`scripts/acceptance/issue-101/install_lifecycle.ps1` with the era installer
at the real target directory: install, real Electron UI smoke (sandbox, IPC,
CSP, sidebar, UI quit and native close), uninstall with data retention,
reinstall — all `PASSED` (recorded on the 0.1.0 candidate; the 0.2.0
installer was additionally exercised by real silent installs, a reinstall
over the same directory, and the per-run NSIS fixture installs of the
update scenarios).

## T108-04 / T109-04 — paired installed update and rollback (passed, runs C8/D1)

Merged into this final matrix per the staged entries in the #108/#109
reports: the single drain-and-install entry on the installed package with a
real signed patch (`updated`, including the product's own window/IPC/echo
usability record), and a deliberately broken patch rolled back to the exact
prior bytes with the recovery lock engaged (`rolled-back`). Evidence:
[issue-108 evidence](../issue-108/evidence/installed-updated-result.json),
[issue-109 evidence](../issue-109/evidence/installed-rollback-result.json).

## Installed acceptance history (0.1.0 era, superseded)

The first installed attempts on the 0.1.0 candidate
(`installed-1`/`installed-2`) failed inside T111-01 with a driver error-
record gap and a profile-identity guard trip caused by the old
profile-swap harness. Both root causes were eliminated: the harness now
uses standard `--user-data-dir` isolation (no profile swap, no identity
guard), and the driver persists `error`/`errorStack` into the result JSON.
The interim 0.1.0 development-candidate matrix (14 cases) and its installer
lifecycle record remain valid history for that candidate; they are not
claimed for the final one.

## Platform scope

Real Win7 remains `unexecuted` under [#131](https://github.com/Orbit-Crew/iDeer/issues/131);
every scenario above was executed on modern Windows only, and no Win7
statement is made or implied.
