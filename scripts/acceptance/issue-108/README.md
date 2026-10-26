# Issue 108 installed acceptance supplement

The drivers use a real installed Desktop, its bundled Runtime and the real
Server Gateway. Identities, profiles, files and databases are synthetic and
isolated. The model deterministically selects the actual file tool. Automated
native-dialog decisions are test inputs; no human approval record is claimed.

## Prerequisites

Use the Desktop candidate's Node dependencies and Python test environment. Build
with `npm.cmd run dist:win`, supplying the reviewed deployment public key through
`IDEER_UPDATES_PUBLIC_KEY_FILE`. Keep its private key outside the repository.
Install the candidate into a disposable test directory with the shared
`resources/nsis/command.cjs` invocation. Retain installer SHA-256 and the trust
sidecar. Never select the ordinary user installation as the test target.

Generate a signed repair release with `scripts/release/issue-107/make-update.cjs`.
The supplement expects a `tray.py` patch with different bytes from the base
installer, and preserves the base app.asar. Other product sources, including
the drain fix, must already be in the base installer. Serve the release under
`UPDATES_CONTROLLED_DIR/desktop/` using the real Gateway `/updates/` routes.
Online tests must not substitute a fixture download handler for those routes.

Start a fresh `issue-102/server_fixture.py` for each run, passing the exact Server
checkout, a fresh Server state directory and a fresh Desktop state directory.
The fixture prints `READY`. Retain the resulting Server source binding.

## Execute online and offline on fresh installations

In Windows PowerShell, set absolute paths for `$node`, `$installed`, `$release`
and `$state`. The installed interpreter prepares synthetic OS credential
references. Each driver cleans up only those references and signals its own
Server to stop.

```powershell
$env:DESKTOP_EXECUTABLE = $installed
$env:IDEER_ACCEPTANCE_UPDATE_RELEASE = $release
$runtimePython = Join-Path (Split-Path $installed) 'resources/runtime/python.exe'
& $runtimePython -I scripts/acceptance/issue-102/profiles.py prepare $state
$env:IDEER_ACCEPTANCE_UPDATE_SOURCE = 'online' # use 'offline' on a fresh run
& $node scripts/acceptance/issue-108/acceptance.cjs $state
```

The test clicks the actual update buttons, cancels installation during a pending
write, then confirms it. It verifies the drain refuses another real dispatch,
the admitted write completes, the changed signed program restarts, and the
Desktop window/renderer/IPC plus Runtime echo are usable. A separate completed
write's Server acknowledgment is deliberately lost. Its actual pending receipt
must survive installation unchanged and later replay under the same owner,
device, Run, Task, request hash and receipt ID. The Server confirms it without
dispatching or executing the file task again.

## Inject storage and unknown-effect blockers

Use a fresh Server and profile. An isolated installed candidate can be reused
after all previous owned processes have exited. Prepare its profile as above,
then run:

```powershell
& $node scripts/acceptance/issue-108/blockers.cjs $state
```

This driver injects a SQLite completion failure in the marked synthetic
receipt database. The write really takes effect, but its evidence cannot be
saved, so installation must be blocked. Removing the trigger and completing a
real durable read clears the storage latch while preserving the original
unknown write. A second installation must still be blocked. Both attempts
check unchanged program hashes, pending-update preservation and continued
Runtime operation.

Process-stop failure and drain-deadline contracts are additionally covered by
`test/install-coordinator.test.ts`. The signed refusal regression is in
`local-runtime/tests/test_install_drain.py`. Keep these contract results distinct
from the installed fault-injection results.

## Evidence and failures

Record commands through `issue-101/record_command.py`. Preserve `result.json`,
the wire log, HTTP summary, screenshots, source binding and cleanup results.
Do not archive profiles, credentials, databases or signing private keys.
Keep unsuccessful attempts with their original exit codes; never relabel them.
The driver now records actual blocked/failed install UI and Runtime state
instead of waiting silently for a maintenance journal that may never appear.

The 2026-10-26 executed run map and limitations are in
`docs/acceptance/issue-108/supplement-20261026.md`. Win7 remains unexecuted under
issue #131.

The later `docs/acceptance/issue-108/timeout-resolution-20261026.md` is the current
record after fixing the status sampling race. `maintenanceObservations` retains
status transitions and actual UI refusals. `IDEER_ACCEPTANCE_STATUS_BARRIER` is
only for a separately instrumented disposable copy used for the documented
before/after diagnostic; it must be absent for final clean-package acceptance.
The product Runtime does not accept that environment variable or contain the
diagnostic hook. The archived task-only private-interface/TCP transport adapters
were used to avoid a broken host WSL localhost forwarder; they relay raw bytes
to the actual Gateway and do not replace any application endpoint.
