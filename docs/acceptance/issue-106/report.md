# Issue 106 acceptance

[iDeer #106](https://github.com/Orbit-Crew/iDeer/issues/106) completes the
Runtime migration switch-over: the Desktop-owned independent Runtime package
carries the full device-side test responsibility, cross-repo tests no longer
depend on the Server repository's device source location, and the duplicated
Server-side copy is retired.

Execution date: 2026-10-24, Asia/Shanghai. Automated execution only; no human
sign-off is claimed. Prerequisites #103/#104/#105 verified closed (104 on
2026-10-23, 105 closed by Orbit-Crew/iDeer-Desktop PR #10 on 2026-10-24).

## Candidate and environment

Desktop branch `feat/issue-106` from develop `b4c7422aa96fcd6eb5acb28964fdf5cae7960c94`
(implementation-free verification candidate; see the closing commit). Server
side: Orbit-Crew/iDeer PR [#142](https://github.com/Orbit-Crew/iDeer/pull/142)
(`feat/issue-106`, commit `78f96dfcb`, base develop `3e728cd6a`).

Windows 11 Pro 10.0.26300 x64; Node 22.14.0; test Python 3.12.8; bundled
Runtime Python 3.12.10; Electron 22.3.27. The cross-repo harness runs the real
Server Gateway from the isolated Server checkout (WSL Ubuntu, its locked
backend venv) with synthetic identities and isolated SQLite databases; the
Desktop side runs the real Electron app with the bundled Runtime. The Server
device broker, signing, pairing, receipts and execution are real code on both
ends. No external model call is claimed (the deterministic fixture model
dispatches the requested authorized tool).

## T106-01 — migration-before test inventory on the independent package

The Server repository's pre-migration device inventory
(`local-runtime/tests/*` plus the backend Runtime-x-broker integrations) maps
onto the Desktop repository as follows; every row ran green on the
independent package (pytest `local-runtime/tests -q`: 365 passed, 6 skipped,
which includes each file below).

| Migration-before inventory (Server repo, now deleted) | Independent package location | Result |
| --- | --- | --- |
| local-runtime/tests/test_transport*.py, test_broker_key_binding.py | local-runtime/tests (same files, authoritative here) | passed |
| local-runtime/tests/test_files.py, test_file_service.py, test_workspace_*.py | local-runtime/tests | passed |
| local-runtime/tests/test_python.py (script execution + artifact grant) | local-runtime/tests | passed |
| local-runtime/tests/test_mcp*.py (stdio MCP contract) | local-runtime/tests | passed |
| local-runtime/tests/test_receipts*.py, test_receipt_ledger.py, test_replay* | local-runtime/tests | passed |
| local-runtime/tests/test_desktop_*.py, test_tray_*.py, test_browser_login.py, test_cli.py, test_settings.py, test_secrets.py, test_policy*.py, test_capabilities.py, test_audit.py, test_protocol.py, test_consent*.py, test_directory_grants.py | local-runtime/tests | passed |
| backend/tests/integration/api/test_devices_router.py::test_local_runtime_client_completes_echo_through_temporary_service | Desktop cross-repo UI matrix T106-04 (signed read task through the real broker) + unit test_transport.py | passed |
| backend/tests/integration/api/test_devices_router.py::test_local_runtime_completes_mcp_task_through_broker_with_receipt (M9) | Desktop unit test_mcp.py / test_mcp_secrets.py on the same core; the Server-side broker half is covered by remaining devices_router broker tests (1691 passed on the shrink tree) | passed (mapped) |
| backend/tests/unit/device_control/test_secrets_gate.py (Runtime client reporting) | Desktop unit test_mcp_secrets.py + test_secrets.py + cross-repo T106-01 receipt assertions | passed (mapped) |
| backend/tests/unit/scripts/*, scripts lane tooling | retained in the Server repo with the lane removed (tests updated, 34 passed) | passed |

Real cross-repo UI matrix (`scripts/acceptance/issue-106/desktop.cjs` against
the real restartable Gateway fixture): scenarios T106-01 through T106-04 all
`passed` (pairing + workspace authorization + signed writes + approval +
durable receipt + device-local result registration with no auto upload;
explicit upload honest-failure semantics while the Server artifact endpoint
is pending; reject / request-hash mismatch / outside-path / protected-path /
junction-escape rejections; Runtime restart + original Thread reopen + signed
read + durable receipt history). Final evidence:
`artifacts/issue-106/functional-9` (result.json `status: passed`, 10 cases,
screenshots, fixture cleanup, credential cleanup).

## T106-02 — standalone package installation

`python -m venv <fresh>` + `pip install ./local-runtime` + importing
`core.transport`, `core.protocol`, `core.desktop` succeeded on the installed
wheel. Desktop tests and build reference only this repository
(`PYTHONPATH=local-runtime`, `.runtime` assembly from `local-runtime/core` +
`resources/provenance/runtime-source.json`); no Desktop file references the
Server repository's device source location. The Server-side adapter
(`agentplatform_extension.local_runtime`) and `app.device_control` implement
their own halves and are unaffected.

## T106-03 — old implementation retirement and clean re-run

Server PR #142 deletes `local-runtime/` (19 core modules, the test tree, the
packaging manifest), `local-runtime-windows.yml`, the shadow lane job, and the
lane references across `scripts/` (`select_test_lanes`, `test_inventory`,
`check_test_contracts`, `report_test_lane_summary`, `test_reference_lookup`,
`run-test-lane.sh`, `test_preflight`), and drops the backend tests that
reached into the deleted copy via sys.path. Focused verification on the
shrink tree: devices_router + auth-gate + unit/scripts + unit/device_control
= 1691 passed, 7 skipped; ruff clean on every changed file. The final UI
matrix above ran against the real Gateway started **from the shrink tree
itself** (`--server-root /tmp/issue-106-shrink`), so the full matrix is
proven against the post-shrink Server in one clean run — no Desktop file and
no harness step references any deleted module. The Server-side PR (#142)
merged as `6a819f3a73dfc2bda5c097e82b47737c9c1058bc` after
maintainer-authorized review with all required checks green.

## T106-04 — gate and entry-point reconciliation

- Desktop repo gates: typecheck, vitest, security lane, provenance,
  runtime-source verification, runtime pytest, ruff, dist:win packaging (see
  Executed commands) plus the PR CI baseline (static-and-contract,
  windows-package).
- Server repo gates for PR #142: backend focused suites as above plus the
  repository's CI lanes; the deleted lane no longer selects.
- Shared-harness changes: none. The issue 104 fixture and base harness are
  reused unchanged; issue 106 adds only its own `desktop.cjs`/`flow.cjs`
  composition.

## Executed commands

| Command | Result |
| --- | --- |
| `npm.cmd run typecheck` (Node 22.14.0) | passed |
| `npm.cmd test` | 24 passed, 12 files |
| `npm.cmd run test:security` | passed |
| `npm.cmd run verify:provenance` | passed |
| `python scripts/verify-runtime-source.py` | passed |
| `ruff check local-runtime --select E9,F63,F7,F82` | passed |
| pytest `local-runtime/tests -q` | 365 passed, 6 skipped |
| `pip install ./local-runtime` in a fresh venv + core imports | passed |
| Server shrink tree: backend focused suites | 1691 passed, 7 skipped |
| Server shrink tree: ruff on changed files | passed |
| Cross-repo UI matrix (`issue-106/desktop.cjs`) | T106-01..04 passed |

## Platform scope and dependencies

Real Win7 remains `unexecuted` per the ticket and is owned by
[#131](https://github.com/Orbit-Crew/iDeer/issues/131). The Server-side
artifact upload endpoint for the issue 105 contract was delivered by Server
PR #143 (merged as `432b60930f499490dafde6e136b1cd2e036f227c`); the
honest-failure assertion recorded in the 0.1.0-era run below was a
transition-state record, not a permanent dependency.

## Final-candidate installed re-verification (0.2.0, passed)

The full installed-candidate matrix was re-run on the final 0.2.0 package
against the real Gateway fixture — binding, environment and run map in
[final-candidate-binding.md](../final-candidate-binding.md); result JSON in
[evidence/installed-matrix-result.json](evidence/installed-matrix-result.json).
T106-01..04 all passed (13 cases), including the explicit upload against the
live Server artifact endpoint with an idempotent repeat, the second-device
download of the exact bytes, and the cross-account refusal — the upload
scenario that could only fail honestly in the earlier run now passes for
real on the installed candidate.
