# Issue 103 real acceptance

The runner reuses Issue 102's real Gateway, signed broker and deterministic
model fixture. The Desktop main/preload/UI and Windows Runtime are actual
candidate code. Chat approvals, directory selection, settings revocation,
logout and detach are Desktop UI actions. Browser login confirmation uses the
synthetic owner's authenticated public HTTP endpoint. No human sign-off or
external model request is claimed.

Use isolated Server databases, A/B users and W1/W2 temporary directories.
Never run against normal user profiles. The installed wrapper backs up the
current Runtime directory and restores every original file/hash after the run.

Start a fresh Server fixture using an absolute candidate Server path and a
new state directory. Do not start the Windows runner until `READY` is present:

```sh
cd SERVER/backend
.venv/bin/python DESKTOP/scripts/acceptance/issue-102/server_fixture.py \
  --server-root SERVER --state /tmp/ideer-t103-UNIQUE \
  --desktop-state DESKTOP/artifacts/issue-103/functional-UNIQUE
```

In Windows PowerShell, from the Desktop checkout:

```powershell
& .runtime/python.exe -I scripts/acceptance/issue-102/profiles.py prepare $taskState
& $taskNode scripts/acceptance/issue-103/desktop.cjs $taskState
# Installed candidate, using its own Python and core files:
pwsh -File scripts/acceptance/issue-103/installed.ps1 -State $taskState `
  -Executable 'D:\software\iDeer Desktop\ideer-desktop\ideer-desktop.exe' -Node $taskNode
```

`$taskState` must be the Windows path for that fixture's desktop-state directory;
`$taskNode` must be an absolute Node 22 executable. Prepare a new fixture for
each development or installed run. Lifecycle helpers are restricted to the
synthetic manifest identities and an owned profile marker. They never print
credentials. Cleanup treats references already deleted by logout/rotation as
retired and continues deleting every remaining synthetic reference.

The result binds Runtime core hashes, Server source fingerprint, acceptance
script hashes, original Run/task/tool identities, exact file hashes and grant
references. Text limits remain 65,536 UTF-8 bytes; approval timeout remains
300 seconds. Observation waits are bounded to 90 seconds. A directory switch
can leave the original Server Run `RESULT_UNCERTAIN` after disconnect; the test
separately checks unchanged file bytes and zero local executions.

Run `scripts/acceptance/issue-101/record_command.py` around commands to retain
stdout, exit code and elapsed time. Do not commit ready manifests, secure-store
reference ledgers, settings files or synthetic private material. Only selected
sanitized result/log/screenshot evidence belongs in the acceptance report.
