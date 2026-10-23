# Issue 104 real fault acceptance

The Server and Desktop/Runtime execute actual candidate code with synthetic
identities and files. The deterministic model only selects the authorized file
tool; the signed protocol, cancellation, persistence and file effects are real.
UI approvals and Stop clicks use the rendered Desktop controls. Native directory
selection uses the existing fixture dialog adapter. No external model call or
human sign-off is claimed.

From the isolated Server checkout's backend directory, using its Python:

```sh
.venv/bin/python DESKTOP/scripts/acceptance/issue-104/server_fixture.py \
  --server-root SERVER --state /tmp/ideer-t104-UNIQUE \
  --desktop-state DESKTOP/artifacts/issue-104/functional-UNIQUE
```

Wait for `READY`. The supervisor restarts the real Gateway process on the
`restart-server` control file while retaining its isolated DB, signing key,
origin, auth secret and synthetic identities. All such material stays ignored.

From the Desktop checkout in Windows PowerShell:

```powershell
& .runtime/python.exe -I scripts/acceptance/issue-102/profiles.py prepare $taskState
& $taskNode scripts/acceptance/issue-104/desktop.cjs $taskState
# Fresh fixture, installed package using its own core and Python:
pwsh -File scripts/acceptance/issue-104/installed.ps1 -State $taskState `
  -Executable 'D:\software\iDeer Desktop\ideer-desktop\ideer-desktop.exe' -Node $taskNode
```

Use absolute paths for `$taskState` and Node 22. Prepare a new fixture for each
development/installed run. The installed wrapper backs up and restores original
Runtime profile files with hash checks. The runner cleans up synthetic OS secret
references and its temporary test directory, then stops the fixture Server.
Never run it against ordinary Server databases or production accounts.

The flow covers pending stop, committed first write followed by stopped second
operation, pre/post-effect disconnect, late receipt after a stopped Run,
duplicate signed task delivery, Runtime crash/restart, Desktop restart, and real
Server process restart. Each case independently checks file bytes, execution
counts, original Run/Task association and UI/history facts. Waits are bounded to
90 seconds. BEFORE, AFTER and SECOND are independent expected UTF-8 literals.
Use `issue-101/record_command.py` to retain exit codes, durations and output.
