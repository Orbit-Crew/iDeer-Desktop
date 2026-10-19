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
the final installer and an isolated Windows account, or explicit authorization
to use the current account.

## Real provider in WSL

`provider_server.py` uses the production Gateway and model factory. It reads the
selected model from an existing Server `config.yaml` and `.env` in WSL. Model
credentials stay in the WSL process environment; the fixture YAML contains
environment references. Use only a configured provider that the user authorized
for synthetic acceptance requests. The Server checkout must be at the candidate
commit above, with its harness and extension dependencies available.

Choose fresh Linux and Windows state directories. For example, from PowerShell:

```powershell
wsl.exe -d Ubuntu -- <ServerPythonLinux> `
  <DesktopRootLinux>/scripts/acceptance/issue-99/provider_server.py `
  --server-root <IsolatedServerCheckoutLinux> --config-root <ExistingConfigRootLinux> `
  --state <FreshServerStateLinux> --desktop-state <FreshDesktopStateLinux> `
  --model <ConfiguredModelName>
```

After `READY`, prepare two synthetic business sessions in Windows Credential
Manager and run the UI probe in a second terminal:

```powershell
.runtime/python.exe -I scripts/acceptance/issue-99/provider_profiles.py prepare <DesktopStateWindows>
node scripts/acceptance/issue-99/desktop.cjs <DesktopStateWindows>
```

The probe adds real published Skill/version binding, unavailable-resource UI
checks and direct Server rejection requests. It observes a real delegated Run
created through the public Server API, archives Run Evidence and message tool
receipts, and verifies that neither duplicate nor offline submission creates an
extra Run. Synthetic markers are fixed in the fixture; model wording may vary.
Each observation has a 60-second deadline. Provider requests use a 45-second
timeout and zero retries. Production Desktop deadlines remain unchanged.

For an installed candidate, first run the repository lifecycle script under an
isolated account or a current account explicitly authorized by the user:

```powershell
./scripts/windows-local-acceptance.ps1 -Installer <FinalInstaller> `
  -InstallDirectory <ExistingRegisteredInstallation> -EvidenceDirectory <EvidenceDirectory>
$env:DESKTOP_EXECUTABLE = '<InstalledExeAbsolutePath>'
node scripts/acceptance/issue-99/desktop.cjs <FreshPreparedDesktopStateWindows>
Remove-Item Env:DESKTOP_EXECUTABLE
./scripts/acceptance/issue-99/shortcuts.ps1 -Executable <InstalledExeAbsolutePath> `
  -EvidenceDirectory <EvidenceDirectory>
```

Installed provider mode uses the real Windows Known Folder. It requires no
existing Runtime settings, creates its settings with an exclusive file open,
checks ownership before each identity switch, then deletes only its own settings.
It does not overwrite an existing login session. The shortcut test opens each
real shortcut visibly and records the actual main-process exit code.

The Node finalizer removes its fixture credentials and writes `stop`, even on a
failed UI run. If setup is interrupted before Node starts, run
`provider_profiles.py cleanup <DesktopStateWindows>` with the bundled Python
and create `<DesktopStateWindows>/stop`. Only references recorded by the fixture
are eligible for removal. Preserve `result.json`, `run-evidence.json`, negative
request summaries, screenshots and cleanup results after checking them for
secrets. Exclude config, profiles, reference lists, DBs, cookies and tokens.
