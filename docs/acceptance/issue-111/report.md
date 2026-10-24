# Issue 111 acceptance

[iDeer #111](https://github.com/Orbit-Crew/iDeer/issues/111) is the phase-one
final-package cross-repo acceptance. This report records the executed state
honestly: the development-candidate matrix and both repositories' gates are
green, the final installer passed the installation lifecycle on the real
target directory, and the installed-package full matrix is staged with
diagnostics rather than claimed.

Prerequisites verified delivered: #106 (Desktop PR #11, Server PR #142 merged
`6a819f3`), #109 (PR #14), #110 (Desktop PR #15, Server PR #145 merged
`591f80c`), plus the Server-side artifact endpoint (#105, PR #143 merged
`432b609`) and the controlled address (#107, PR #144 merged `169c175`).

Execution date: 2026-10-24, Asia/Shanghai. Automated execution only.

## Candidate and environment

Desktop branch `feat/issue-111` from develop `e812e05c5afea875f46551dc911bf6e5e093dadf`
(no product code changes; the candidate is the develop tree itself).
Final installer `ideer-desktop-0.1.0-windows-x64-setup.exe` (92,395,830 bytes),
SHA-256 `238f86e7eb5aef751495ec0c6ca8586d1f251140f887cd724c2fd20516392c48`,
built from this tree. Server: develop `591f80cf3` (real Gateway fixture).
Windows 11 Pro 10.0.26300 x64; Node 22.14.0; Electron 22.3.27; bundled
Runtime Python 3.12.10.

## T111-01/02/03 — development-candidate matrix (passed)

`scripts/acceptance/issue-111/desktop.cjs` against the real restartable
Gateway from the Server tree (`591f80cf3`), real Electron + bundled Runtime.
Evidence: `artifacts/issue-111/functional-12` (result.json `status: passed`,
14 cases). Scenario highlights:

- T111-01: pairing, workspace authorization, a streamed turn to a terminal
  Run, Runtime restart, and the original Thread reopened (`2` cases).
- T111-02: overwrite with per-approval, refusal, request-hash mismatch
  (`CONSENT_MISMATCH`), the directory grant (receipt records its
  `directory:<grantId>` decision) removing later approval cards, and the three
  unsafe-path refusals — `8` cases, all side-effect-exact.
- T111-03: a committed first write kept while stopping the Turn awaiting the
  second approval (interrupted, `0` executions), the explicit upload against
  the **live Server artifact endpoint** (`art-94c3f1415d20` — the content
  hash of the uploaded bytes, `uploaded_at` recorded), and the signed read
  proof (`4` cases).

## T111-04 — gates and records

- Desktop repo PR CI on this branch: `static-and-contract` and
  `windows-package` (packaging + installer smoke) — recorded on the PR.
- Server repo gates for the delivered dependency PRs #143/#144/#145: all
  required checks green (backend blocking-IO, Layer 1 golden, Layer 2
  full-stack render, migration and Real E2E gates).
- Runtime pytest 367 passed/6 skipped and vitest 44 passed on the develop
  tree (recorded in the merged dependency-PR reports).

## Installation lifecycle (passed)

`install_lifecycle.ps1` with the final installer at the real target
directory: install, real Electron UI smoke (sandbox, IPC, CSP, sidebar, UI
quit and native close), uninstall with data retention, reinstall — all
`PASSED`; evidence in `artifacts/issue-111/lifecycle`.

## T111 installed-package full matrix — staged (incomplete)

Two installed runs (`artifacts/issue-111/installed-1`, `installed-2`) with
the isolated Runtime-profile harness reached a paired, streaming state on the
installed candidate (failure snapshots contain real resources and a
successful Run) but the node driver process exited without its error record
during T111-01, and the second run then tripped the profile-identity guard.
The development matrix, the installer smoke, and the snapshots bound the
candidate; the installed full matrix must be re-run and green before this
issue closes — it is deliberately **not** claimed here.

## Platform scope

Real Win7 remains `unexecuted` under [#131](https://github.com/Orbit-Crew/iDeer/issues/131).
