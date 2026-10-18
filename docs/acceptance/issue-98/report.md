# Issue #98 acceptance

Execution date: 2026-10-18, Asia/Shanghai. Executor: Codex. Desktop review base
`2fbfa8528a3f77b11cbf68b8e3f338ec08c1db94`; Server review base
`ccb251e07e5f5934b851e4c3df00224718f28123`. Both candidates are currently uncommitted.
Final candidate commits, installer SHA-256, final dependency/config/environment
manifest and installed verification are pending. This report does not authorize
closing the issue while required evidence remains incomplete.

## Scenario record

| Scenario | Automatic | Browser/installed candidate | Current evidence |
| --- | --- | --- | --- |
| T98-01 | passed for focused HTTP/Runtime exchange | incomplete | Server `test_browser_confirmation_does_not_create_desktop_session_until_exchange`; Runtime `test_runtime_exchanges_then_stores_separate_credentials_without_renderer_secrets`. Browser confirmation returns no tokens; completion returns distinct business/device credentials and the correct owner. Real public-entry/browser/installed workflow remains to be recorded. |
| T98-02 | passed for focused HTTP rejection | incomplete for final real integration | Wrong initiator/key `401 LOGIN_BINDING_INVALID`; wrong confirmed owner `403 LOGIN_OWNER_MISMATCH`; expiry `410 LOGIN_EXPIRED`; replay `409 LOGIN_ALREADY_USED`. Concurrent exchange has exactly one `200` and one `409`, with one visible device. Existing device authentication gates and signed WS/MCP regressions pass. |
| T98-03 | passed for fault injection and bounded IPC | incomplete for final OS-store/package inspection | Runtime secure-store fault yields `SECURE_STORAGE_FAILED`, no settings or plaintext fallback files. Credential bytes never appear in returned status/settings/browser URL. Main validates HTTPS origin and the fixed browser path before opening. Real Windows Credential Manager and installed renderer/log checks remain to be recorded. |
| T98-04 | passed for inherited signed WebSocket regression | incomplete for real public-entry reconnect | nginx local/Docker/Helm expose exact `/api/devices/ws` with HTTP/1.1 Upgrade and 3600-second read/send bounds. Runtime expires business auth visibly and does not start an executable device connection for expired business profiles. Real proxy cut/recovery evidence remains to be recorded. |

## Reproducible focused checks

From Desktop, use Node 22.23.3 and the pinned virtual environment:

```powershell
$env:PYTHONPATH='local-runtime'
.venv/Scripts/python.exe -m pytest local-runtime/tests/test_browser_login.py -q --basetemp=artifacts/issue-98/pytest-auth-gate-green
.cache/node22/node-v22.23.3-win-x64/node.exe node_modules/vitest/vitest.mjs run test/login.test.ts
npm.cmd run typecheck
python scripts/verify-runtime-source.py
```

Latest focused observations: Runtime 10 passed in 4.51 seconds; Desktop login,
security and startup together passed 4 tests in 14.18 seconds, including concurrent
login admission. Both TypeScript projects passed; source verification passed. Baseline
Runtime pytest runner lacked pytest-timeout and reported one configuration
warning. Final environment must install the declared test extra before full lanes.

From Server `backend/`, with its locked Python 3.12 environment:

```powershell
.venv/Scripts/python.exe -m pytest tests/integration/api/test_desktop_login.py -q --basetemp=../dev-log/pytest-login-green-6 -p no:cacheprovider
.venv/Scripts/python.exe -m pytest tests/integration/api/test_devices_router_auth_gate.py tests/integration/api/test_devices_router.py tests/integration/persistence/test_migration_0025_repair_run_change_seq.py -q --basetemp=../dev-log/pytest-login-regression -p no:cacheprovider
```

Observed: original four login cases passed in 10.85 seconds; adding same-device
reauthentication produced 5 passed in 30.72 seconds. The final visible-offline
renewal refinement passed all 5 cases in 43.82 seconds. Affected existing regressions 10 passed in
17.19 seconds. Exact literals are from #98's contract and fixture inputs.
Exchange TTL is 300 seconds; the clock test advances 301 seconds. Business and
device sessions expire after one hour. Runtime HTTP requests have a 10-second
timeout; Desktop login startup has a 15-second bound; process shutdown has a
12-second force-stop bound. String/status comparisons have no numeric tolerance.

Server new Python files and touched device/auth/model/migration/test files pass
ruff. New browser page passes Prettier and ESLint. Server frontend full tsc in
this nested checkout currently sees unrelated ancestor Electron DOM typings;
validation from an isolated checkout is pending.

## Red and green evidence

Initial HTTP, Runtime login and Desktop IPC tests preceded their implementation.
Runtime login initially failed import
because `core.browser_login` did not exist; its exchange then passed. Desktop
login initially failed `runtime.beginLogin is not a function`, then passed.
Business expiry initially remained `authenticated`; the clock regression now
reports `expired / LOGIN_EXPIRED`. Expired business-profile stdio initially
crashed, and now stays alive with `offline / expired`. Device-only Desktop
profiles also remain `offline / unauthenticated`. Review added same-device
reauthentication and concurrent IPC regressions; those passed without a retained
pre-fix red run. Reauthentication requires the same owner and existing private-key
proof, keeps the device ID and rejects old device sessions.

Server's first execution was blocked by antivirus quarantine of two unchanged
baseline scanner files. The user restored and trusted them. Windows then exposed
the existing unconditional uvloop test fixtures; those now retain uvloop when
available and use native asyncio otherwise. Once collection worked, HTTP tests
found a real SQLite aware/naive datetime failure in atomic updates. Disabling
ORM in-memory synchronization for the SQL compare-and-swap fixed it. A post-hoc
isolated baseline router replay subsequently produced the expected first-test
failure, `404 != 200`, with 1 failed / 4 deselected in 27.18 seconds. It read
`HEAD:backend/app/gateway/routers/devices.py` into ignored session storage and
changed no product files. Evidence is Server `dev-log/login-baseline-replay.log`.
Final standard lanes remain to be recorded.

## Remaining platform evidence

Real Win7: unexecuted, explicitly assigned to
[#131](https://github.com/Orbit-Crew/iDeer/issues/131), owner Neowyh. Verify browser
handoff, Credential Manager, bundled interpreter/crypto/TLS, signed WS reconnect,
Job Object ownership, install/start/exit and all T98-01 through T98-04 scenarios
on actual Win7. No modern Windows result is a Win7 compatibility claim.
