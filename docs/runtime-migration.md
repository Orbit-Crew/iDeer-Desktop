# Runtime migration for issue #97

Issue #98 extends this accepted baseline with browser login and a restricted
login command. Its current behavior and validation are in
[issue #98 acceptance](acceptance/issue-98/report.md); the sections below retain
the original #97 migration record.

Desktop baseline: `a41817d`. Runtime and Server protocol source:
[Orbit-Crew/iDeer ccb251e](https://github.com/Orbit-Crew/iDeer/tree/ccb251e07e5f5934b851e4c3df00224718f28123).
The prerequisite [#96](https://github.com/Orbit-Crew/iDeer/issues/96) was rechecked
as closed/completed. Scope belongs to [#97](https://github.com/Orbit-Crew/iDeer/issues/97).

## Process and configuration

Electron owns one bundled Python process. Renderer IPC exposes status, quit,
start Runtime and stop Runtime. Start takes no executable, arguments or task.
Main-frame sender checks, sandbox, context isolation, navigation and CSP remain
enforced. The existing Runtime owns all tool execution; there is no HTTP listener.

Installed resources are resources/runtime/python.exe, stdlib, locked wheels and
core/. Development uses .runtime/ with the same layout. Shell expansion is off;
the executable, module and arguments are fixed. Python -I ignores environment
injection. Stdout carries bounded process/connection/task summaries, without
inputs, outputs or credentials. Stopped/crashed/unresponsive processes report
offline. An unconfigured installation reports not-configured and executes no tasks.

The fixed settings file is `%APPDATA%/iDeer Desktop/Runtime/settings.json`.
Local administration uses the existing owner-confirmed pairing through bundled
`python.exe -I -m core.cli pair-start` and `pair-complete`, with --config pointing
to this file. Consult those commands' --help for pairing arguments. This ticket
adds no login UI or manual long-lived-token copying flow.

The Desktop entry requires a device identity, pinned Server public key and OS
credential references for session/device key. It refuses plaintext session tokens,
unpinned trust and missing stored keys. It creates no replacement key for a
configured identity. Tests create and delete unique Credential Manager entries.

Stdin accepts only shutdown; EOF also shuts down the controller. Desktop waits
before quitting and terminates a child stalled beyond 12 seconds. The Runtime's
Windows Job Object kills MCP descendants on Runtime crash. Connection becomes
connected only after verification of the pinned broker HELLO.

SQLite commits each device/task admission before dispatch. Claims survive restart
and crash, including uncertain outcomes. Server owns reconciliation; Desktop never
re-executes an old task or fabricates a successful receipt. Policy, consent, MCP,
receipts, audit and secret resolution otherwise use the original implementation.

## Source and test mapping

resources/provenance/runtime-source.json records every original Git blob.
`python scripts/verify-runtime-source.py` checks every unchanged source and test.
The Server protocol module is copied unchanged into tests/server_protocol.py for
independent signing/receipt verification; Pydantic is a test dependency only.
The old Server Runtime stays as a fixed cutover comparison. This ticket neither
deletes it nor creates a parallel synchronization development branch.

| Original tests in local-runtime/tests | Coverage retained in Desktop |
| --- | --- |
| test_protocol, test_broker_key_binding | Signature, expiry, pinned-key binding |
| test_transport, test_transport_split, test_tray_transport | Wire protocol, receipts, teardown |
| test_policy, test_policy_denial, test_consent, test_consent_summary | Policy, DENY, exact-content consent |
| test_mcp, test_mcp_secrets, fixtures/filesystem_mcp_server.py | stdio/HTTP, managed lifecycle, secret resolution |
| test_files, test_file_service, test_python | Roots, reparse points, execution/cancellation |
| test_secrets, test_cli, test_settings, test_audit, test_capabilities, test_receipts | Credentials, config, audit, capability/receipt contracts |
| test_tray_actions, test_tray_consent, test_tray_lifecycle, helpers_fake_broker.py | Controls, reconnection, consent, signed broker |

New test_desktop_protocol.py covers public WebSocket replay/signature/expiry/DENY.
test_desktop_process.py uses the embedded interpreter, disposable OS identity,
unchanged Server protocol, counting MCP fixture and exact side-effect ledger.
It checks signed echo/MCP results/receipts, durable replay, restart and crash cleanup.
test/runtime.test.ts and scripts/desktop-smoke.cjs cover owned process lifecycle
and installed UI start/stop/crash/recovery, quit and native window close.

## Changes to copied files

| File | Change and reason |
| --- | --- |
| core/transport.py | Verify HELLO before connected; persistent task admission before dispatch; signed rejection receipts; denied echo returns no value |
| core/python.py | Cancel/timeout closes the already assigned Windows Job Object immediately. The original regression reproduced a descendant side effect while taskkill was starting; all 22 original Python tests pass after the fix |
| pyproject.toml | Pin production versions, retain explicit core wheel package fix, add Desktop entry and test extras/config |
| core/settings.py, issue #98 | Add separate business identity and OS credential references plus business expiry; preserve plaintext-free serialization |

Issue #98 adds `core/browser_login.py` and extends Desktop-only `core/desktop.py`.
Runtime holds the initiating secret and device private key, polls a five-minute
one-use completion, and persists separate business/device credentials only in
the OS store. Browser URL contains only the temporary login ID. The new
`desktop:login:begin` IPC accepts a canonical platform origin and device name;
main opens only a matching-origin `/desktop-login?login_id=...` URL and returns
no URL or credential to renderer. Existing task IPC remains absent. Profiles
require a valid business session before connecting; expiry stops their controller.
Existing device-only Desktop profiles remain offline until the same owner
confirms a business login and the stored device key proves possession. Reauthentication
keeps the device ID, replaces its session and invalidates old sessions.
`test_browser_login.py` adds public HTTP/stdio
checks; all migrated original test bytes remain unchanged.

All original tests remain unchanged. Windows skips and their platform reasons are
recorded in acceptance. CPython 3.12 is a modern Windows candidate. Win7 interpreter,
crypto and Job Object compatibility remain unexecuted and assigned to #131.

## Build and evidence

`npm.cmd run dist:win` prepares the Runtime before NSIS packaging.
distribution.lock.json pins the official CPython archive and four wheels by URL
and SHA-256. Build output retains their licenses and LICENSE.upstream.
scripts/verify-issue-97.ps1 saves commands, exit codes, durations, test counts,
dependency graph, environment and hashes in artifacts/issue-97/.
The acceptance record is docs/acceptance/issue-97/report.md. Test results do not
close the issue or publish a release.
