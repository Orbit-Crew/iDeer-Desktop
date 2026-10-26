# Issue #111 final installed-package re-acceptance

Run on modern Windows with the bound NSIS installer, Node 22 and the locked
test Python. Each mode creates a fresh TEMP installation and standard
`--user-data-dir`. The real user profile is outside the fixtures.

## Automatic matrix

`run-base.ps1` starts the real Gateway and uses the existing signed-task
fixtures. Its model deterministically selects actual Windows Runtime tools.
It does not replace HTTP, broker authorization, local execution or receipts.

```powershell
& scripts/acceptance/issue-111/run-base.ps1 -Mode $mode -State $freshState `
  -Node $node -Python $python -Installer $installer -PrivateKey $privateKey `
  -ServerRoot $serverRoot
```

Keep the signing private key outside the checkout. All paths are absolute.
`$serverRoot` is the Linux Server checkout, not an upstream-only main branch.

| Mode | Coverage | Main issue scenarios |
| --- | --- | --- |
| `matrix` | Installed pairing, streaming/history, search, approval/refusal, request binding, directory grant, unsafe paths, stop and explicit upload. | T111-01/02/03 |
| `writes` | Complete #102 matrix including real 300-second approval expiry, local deny, storage failure, unknown write, disconnect/stop/restart and no redispatch. | T111-02/03 |
| `identity` | Complete #103 directory/account/device lifecycle, revocation and ownership refusals. | T111-02/03 |
| `artifacts` | Complete #105 live upload/idempotency, second-device download hash, cross-user refusal and revoked producer. | T111-02/03 |
| `online` / `offline` | Complete #108 drain/install/health/real original pending-receipt replay on both paths. Pass `-ReleaseManifest` for the signed changed payload. | T111-03 |
| `recovery` | #109 actual failed update, exact rollback, restored file functions, original receipt replay, authorization and KB metadata preservation. | T111-03 |

`composed.cjs` adapts the existing #102/#103 entry points to isolated installed
profiles. It retains their independent expectations and actual product clocks.
The launcher fails if the result or process exit fails. Identity cleanup retains
the actual lifecycle helper's result, including credentials already retired by
logout/rotation; it does not try to delete them a second time.

## External provider and installation lifecycle

```powershell
& scripts/acceptance/issue-111/run-provider.ps1 -State $freshProviderState `
  -Node $node -Python $python -Installer $installer -PrivateKey $privateKey `
  -ConfigRoot $linuxConfigRoot -Model $configuredModel -ServerRoot $serverRoot
& $node scripts/acceptance/issue-111/lifecycle.cjs $installer $absoluteResult
```

The provider fixture uses an existing configured model but keeps endpoint and
credential values in the Linux process environment. It creates synthetic
regular accounts and published Agent/Skill resources in a separate database.
The actual public login/device-pairing APIs and Windows credential store prepare
the installed Runtime. The driver submits one bounded real-model marker turn,
checks streamed message events and immutable resource selection, then restarts
the actual app and opens the original Thread/Run. No provider request or secret
is faked. `provider-profiles.py` supplies real device bindings required by the
current login-restore contract; a business-token-only old fixture is insufficient.

`lifecycle.cjs` exercises actual install, launch, UI quit, uninstall, data
retention, reinstall and native-window closure. It records Electron/Node,
software-rendering switch, sandbox, context isolation and actual preload IPC.
Its retained-data canary belongs to the isolated profile, not a real user file.

## Host transport and cleanup

When automatic WSL localhost forwarding fails, the existing task-only raw TCP
proxy binds Windows `127.0.0.1` and forwards to the real private-interface
Gateway. Under heavy test load, Windows-to-WSL process startup can also time out.
An optional task-owned `gateway-supervisor.py` keeps one Linux launcher alive:

```sh
SERVER/backend/.venv/bin/python DESKTOP/scripts/acceptance/issue-111/gateway-supervisor.py QUEUE
```

The queue must be below `artifacts/issue-111` and contain an `owner` file with
`ideer111-task-owned`. Pass its Windows path as `-Supervisor` to either launcher.
It accepts only the two reviewed Gateway fixtures and task-owned state paths;
it executes no shell commands and carries no model credentials or fake business
responses. Each completed case signals its Gateway/proxy to exit. At the end,
create `QUEUE/stop` and retain the supervisor's `cleanup.json`. No WSL restart,
firewall or system portproxy change is part of this workflow.

Run fresh installations sequentially. Retain command/exit/duration records,
sanitized results and screenshots. Preserve failed attempts separately. Record
credential and process cleanup failures as failures, even when assertions pass.

## Gates and human completion

Use the actual Server `core-full` lane and record every child and parent result.
Use the pinned pnpm through a task PATH, not a global `TEST_PNPM_BIN` inherited
by tests that intentionally replace PATH. Frontend dependencies must be inside
the checkout's filesystem root for Turbopack. An external `node_modules`
symlink can pass unit tests but fail the real browser server startup.

These automated runs authenticate and approve synthetic inputs through actual
APIs and UI controls. They do not constitute the human browser login or human
signoff required by [iDeer #111](https://github.com/Orbit-Crew/iDeer/issues/111).
Record those separately as passed only after the human performs them. Missing
required human or automatic results keep #111 incomplete. Real Win7 remains
unexecuted under [#131](https://github.com/Orbit-Crew/iDeer/issues/131).

## Human browser login

`manual-server.py` composes the same real-provider Gateway, then copies the
candidate frontend into task-only Linux state, verifies each copied file's
SHA-256, and copies the same locked dependencies. It starts real Next on port
13112 with the Gateway and CSRF trusted origin set to the Windows loopback
origin. The copy avoids sharing `.next` with `core-full`; no product source or
authentication bypass changes are made.

Before the human begins, run `manual-setup.py STATE/desktop` using Python. It
initializes the fresh database via the official `/api/v1/auth/initialize` API
with a separate synthetic bootstrap admin and discards its session cookies.
A/B stay regular users. Confirm `system-initialization.json` has
`needs_setup=false`; otherwise the actual browser login redirects to setup.

Use fresh `artifacts/issue-111/human-login`. Start `manual-proxy.cjs STATE`
with the driver Node, read `STATE/public.json`, and pass that origin as
`IDEER_T111_PUBLIC_ORIGIN` to the Server Python invocation:

```sh
SERVER/backend/.venv/bin/python scripts/acceptance/issue-111/manual-server.py \
  --server-root SERVER --config-root EXISTING_CONFIG_ROOT \
  --state /tmp/FRESH_TASK_STATE --desktop-state STATE/desktop \
  --model agnes-3.0-flash
```

Run the existing `issue-109/fixture.cjs` installer preparation into
`STATE/installation.json`. Set `DESKTOP_EXECUTABLE` from that record, then run
`manual-desktop.cjs STATE/desktop` with the driver Node. The initial profile
must have no settings or prepared business session. It fills only the platform
origin and device name. The human clicks the Desktop browser-login button,
enters the synthetic account in real Next, compares the verification code and
confirms ownership. Do not automate those authentication actions.

The OS browser-launch boundary is adapted to open Edge with a fresh
`--user-data-dir` below the owned state. No cookies or sessions are inserted.
Gateway/Next authentication, CSRF, pairing and Runtime one-use exchange remain
real. The driver records state changes, waits up to 30 minutes for the human,
then performs actual model selection/stream/history checks. A started pairing
request retains its real five-minute product expiry; restart the isolated run
after expiry rather than claiming it passed.

`manual-profile.py` retires only this owned profile's `desktop-` references via
actual `BrowserLogin.logout(forget_device=True)`. The driver signals
`STATE/desktop/stop` for Gateway/Next; create `STATE/stop` after evidence capture
to stop the raw TCP proxy. Close only the isolated test Edge window. Preserve
all process and credential cleanup records. Final report signoff is a separate
human action after the complete report is available.
