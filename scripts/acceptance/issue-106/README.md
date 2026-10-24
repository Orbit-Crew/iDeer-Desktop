# Issue 106 switch-over acceptance

The Desktop-owned independent Runtime package (bundled `.runtime`, source
`local-runtime/`) runs the real Desktop UI against the real isolated Server
Gateway. No Server-side device code is imported by Desktop tests or the
harness: the only Server surface is its signed device broker over HTTP/WebSocket.

From the isolated Server checkout's backend directory, using its Python (issue
104's restartable fixture is reused unchanged):

```sh
.venv/bin/python DESKTOP/scripts/acceptance/issue-104/server_fixture.py \
  --server-root SERVER --state /tmp/ideer-t106-UNIQUE \
  --desktop-state DESKTOP/artifacts/issue-106/functional-UNIQUE
```

Wait for `READY`. From the Desktop checkout in Windows PowerShell:

```powershell
& .runtime/python.exe -I scripts/acceptance/issue-102/profiles.py prepare $taskState
& $taskNode scripts/acceptance/issue-106/desktop.cjs $taskState
```

Use absolute paths for `$taskState` and Node 22. Prepare a new fixture for
each run. The runner cleans up synthetic OS secret references and its
temporary test directory, then stops the fixture Server.

Scenarios: T106-01 pairing + signed workspace write + durable receipt +
device-local result registration (no auto upload), T106-02 explicit upload
honest-failure semantics while the Server artifact endpoint is pending,
T106-03 the unchanged local safety contract (reject, hash mismatch, outside
path, protected path, link escape), T106-04 Runtime restart, original Thread
reopen, signed read task and durable receipt history.
