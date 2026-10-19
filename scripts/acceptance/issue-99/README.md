# Issue 99 verification

Use Node 22, the locked Desktop dependencies, a prepared `.runtime`, and the
Server Python environment from commit
`95260f452670df62e365f10035d095838ec3a495`. Server code is not patched by these
fixtures. The Python environment must contain its locked dependencies and
editable harness/extension packages.

Run the local regressions from the Desktop root:

```powershell
npm.cmd run typecheck
npm.cmd test
$env:PYTHONPATH="$PWD/local-runtime"
python -m pytest local-runtime/tests -q
npm.cmd run dist:win
```

The real Gateway probe uses synthetic regular accounts, task-owned SQLite and
resource directories, and two temporary Windows Credential Manager entries.
Its Server model is deterministic, following the Server's existing integration
test convention. It does not validate an external provider, browser pairing,
installed-app lifecycle or a production deployment. No existing Desktop profile
is modified.

Choose a new, nonexistent fixture directory under ignored `artifacts/issue-99`.
Start the Gateway with the actual Server Python environment in one terminal:

```powershell
<ServerPython> scripts/acceptance/issue-99/gateway_fixture.py `
  --server-root <ServerCheckout> --state artifacts/issue-99/gateway-run
```

After it prints `READY`, run from the Desktop root in another terminal:

```powershell
node scripts/acceptance/issue-99/desktop.cjs artifacts/issue-99/gateway-run
```

The Node script launches the actual built Electron main/preload/renderer and
bundled Runtime under a task-owned appData directory. It verifies concurrent
same-Turn requests, normal Server response, a clarification choice through UI,
restart history, A/B/A isolation and forced private-resource rejection. A
task-owned TCP proxy interrupts an established stream, proves an unavailable
Server error, then restores the same Run without a new submission.

`result.json`, `desktop-chat.png` and `cleanup.json` record results. The Node
script writes the fixture's `stop` file in its finalizer. If interrupted before
that finalizer, create `<fixture>/stop` and let the Python owner exit normally;
it deletes only its own credential references. Never publish the SQLite DB,
settings profiles, config or raw credentials. Preserve only the redacted results
and selected evidence listed in the acceptance report.

For packaged smoke, point `DESKTOP_EXECUTABLE` at the canonical Windows path of
`dist/win-unpacked/ideer-desktop.exe`, set `DESKTOP_EVIDENCE_DIR` to a task-owned
directory and run `node scripts/desktop-smoke.cjs`. This verifies a packaged
payload, not NSIS installation/uninstallation. Installed-app verification needs
an isolated Windows test account and the final installer, as required by #99.
