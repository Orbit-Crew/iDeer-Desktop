# Issue 98 local acceptance

Run from the Desktop repository on Windows with Node 22.23.3, the locked Desktop
and Server dependencies, prepared `.runtime`, Playwright Chromium, and the actual
NSIS installer. These scripts are fixtures, excluded from the packaged app.
The dated results and limitations are in
[`docs/acceptance/issue-98/report.md`](../../../docs/acceptance/issue-98/report.md).

Place a Server checkout at `artifacts/issue-98/server`, or pass `--server-root`
to `services.py` and set `IDEER_T98_SERVER_ROOT` for the Node scripts. The recorded
run used nginx 1.31.7 from `https://nginx.org/download/nginx-1.31.7.zip`, extracted
to `.cache/nginx-1.31.7`; archive SHA-256
`7c717ccf861f8925be64431d06d57634512a5014bcc8d149f279928f5e8151bf`.
The fixture expects Node at `.cache/node22/node-v22.23.3-win-x64/node.exe` and
the Server Python environment at `backend/.venv/Scripts/python.exe`.

Start the real Gateway, Next and nginx in a separate terminal:

```powershell
.venv/Scripts/python.exe scripts/acceptance/issue-98/services.py --server-root artifacts/issue-98/server
```

This binds loopback ports 21980, 21981 and 21982. Occupied ports fail immediately.
It overrides both modern and compatibility configuration variables, disables
dotenv loading and authentication bypass, and stores SQLite/configuration only
in Server `dev-log/live-98`. Initialize this isolated platform through its public
`http://127.0.0.1:21980` setup page. Register `user98a@test.com` and
`user98b@test.com` through its normal registration API, with each fixture password
equal to its email, as specified by the Server test-account convention. These
accounts must exist only in the isolated fixture. Models and external tools are
not needed for device authentication.

With that deployment running:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/ms-playwright"
.cache/node22/node-v22.23.3-win-x64/node.exe scripts/acceptance/issue-98/installed_login.cjs
.runtime/python.exe -I scripts/acceptance/issue-98/storage_failure.py --profile artifacts/issue-98/storage-failure-new
.runtime/python.exe -I scripts/acceptance/issue-98/rejections.py
$env:IDEER_T98_NETWORK_GUARD='1'
.cache/node22/node-v22.23.3-win-x64/node.exe scripts/acceptance/issue-98/flow.cjs
```

Run these sequentially. `installed_login.cjs` requires an unused installed
Runtime profile and no running installed Desktop. It calls the actual system
browser opener, then automates a separate Chromium instance on the same real
login route. It verifies the installed UI, restricted IPC, ownership, online
device, restart and Runtime exit, then removes only its generated settings and
three OS credential entries. Override the installed executable with
`IDEER_T98_INSTALLED_EXECUTABLE` if necessary.

`storage_failure.py` forces the real Windows Credential Manager blob-size
rejection; it does not change OS security policy. `rejections.py` waits the real
five-minute exchange TTL, checks HTTP rejection codes and concurrent completion,
and never writes returned tokens. `flow.cjs` tests Runtime login and restart,
unauthenticated WS rejection, and proxy loss/recovery. The network guard blocks
Runtime socket connections to every port except the unified entry, while
allowing the Windows event loop's private socket pair. This is transport fault
injection, not an OS firewall rule. Proxy termination verifies executable,
configuration and process ownership before terminating its fixture tree.

`flow.cjs` stops the fixture proxy when finished. Stop `services.py` by creating
Server `dev-log/live-98/stop-services`, then start it again for another full run.
To remove the OS credentials retained by a completed Runtime fixture, first
ensure that Runtime has exited, then use its explicit profile path:

```powershell
.runtime/python.exe -I scripts/acceptance/issue-98/cleanup_profile.py --profile artifacts/issue-98/server/dev-log/live-98/runtime-profile-<timestamp>
```

The cleanup accepts only the generated T98 profile name, loopback origin, device
name and three matching credential-reference names. It retains the settings as
reference-only evidence and never enumerates unrelated OS credentials. Preserve
redacted results/screenshots; do not commit the database, cookies or raw tokens.
