param(
  [string]$Installer = 'dist/ideer-desktop-0.1.0-windows-x64-setup.exe',
  [string]$InstallDirectory = 'D:\software\iDeer Desktop\ideer-desktop',
  [string]$PythonExecutable = '.venv/Scripts/python.exe',
  [string]$EvidenceDirectory = 'artifacts/issue-97/installed'
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$pythonPath = (Resolve-Path -LiteralPath $PythonExecutable).Path
$installPath = (Resolve-Path -LiteralPath $InstallDirectory).Path
$executable = Join-Path $installPath 'ideer-desktop.exe'
$registration = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' | Where-Object DisplayName -eq 'iDeer Desktop')
if ($registration.Count -ne 1 -or $registration[0].UninstallString -notlike "*$installPath*") { throw 'The requested directory must match the existing Desktop installation' }
$config = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'iDeer Desktop/Runtime/settings.json'
if (Test-Path -LiteralPath $config) { throw 'Configured profile present; this unconfigured UI smoke must not overwrite it' }
$evidence = [IO.Path]::GetFullPath((Join-Path (Get-Location) $EvidenceDirectory))
New-Item -ItemType Directory -Force -Path $evidence | Out-Null
$commands = [System.Collections.Generic.List[object]]::new()
function Record([string]$name, [DateTimeOffset]$started, [long]$elapsed, [int]$result) {
  $commands.Add(@{ name=$name; startedAt=$started.ToString('o'); elapsedMs=$elapsed; exitCode=$result })
  $commands | ConvertTo-Json | Set-Content (Join-Path $evidence 'commands.json') -Encoding utf8
  if ($result -ne 0) { throw "$name failed ($result)" }
}
foreach ($current in @(Get-Process ideer-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $executable -and $_.MainWindowHandle -ne 0 })) {
  if (-not $current.CloseMainWindow()) { throw 'Existing Desktop could not close gracefully' }
}
$deadline=(Get-Date).AddSeconds(25)
while (@(Get-Process ideer-desktop -ErrorAction SilentlyContinue | Where-Object Path -eq $executable).Count -gt 0) {
  if ((Get-Date) -gt $deadline) { throw 'Existing Desktop remains running' }
  Start-Sleep -Milliseconds 200
}
$started=[DateTimeOffset]::Now
$timer=[Diagnostics.Stopwatch]::StartNew()
$install = Start-Process -FilePath $installerPath -ArgumentList "/S /D=`"$installPath`"" -WindowStyle Hidden -Wait -PassThru
Record 'install' $started $timer.ElapsedMilliseconds $install.ExitCode
$bundledPython=Join-Path $installPath 'resources/runtime/python.exe'
foreach ($relative in @('resources/app.asar','resources/runtime/python.exe','resources/runtime/core/desktop.py','resources/runtime/LICENSE.ideer-runtime.txt')) {
  $expected=Get-FileHash -LiteralPath (Join-Path 'dist/win-unpacked' $relative)
  $actual=Get-FileHash -LiteralPath (Join-Path $installPath $relative)
  if ($expected.Hash -ne $actual.Hash) { throw "Installed file differs: $relative" }
}
& $bundledPython -I -c 'import sys,cryptography,websockets,cffi,pycparser; print(sys.version); print(cryptography.__version__,websockets.__version__,cffi.__version__,pycparser.__version__)' |
  Tee-Object (Join-Path $evidence 'installed-python.txt')
if ($LASTEXITCODE -ne 0) { throw 'Installed Python import check failed' }
$env:IDEER_TEST_PYTHON=$bundledPython
$env:IDEER_TEST_EVIDENCE=$evidence
$env:PYTHONPATH=(Resolve-Path local-runtime).Path
$started=[DateTimeOffset]::Now
$timer.Restart()
& $pythonPath -m pytest local-runtime/tests/test_desktop_process.py -q "--junitxml=$evidence/signed-process.xml" 2>&1 | Tee-Object (Join-Path $evidence 'signed-process.log')
Record 'installed-signed-process' $started $timer.ElapsedMilliseconds $LASTEXITCODE
$env:DESKTOP_EXECUTABLE=$executable
$env:DESKTOP_EVIDENCE_DIR=$evidence
$started=[DateTimeOffset]::Now
$timer.Restart()
& node scripts/desktop-smoke.cjs 2>&1 | Tee-Object (Join-Path $evidence 'desktop-smoke.log')
Record 'installed-desktop-smoke' $started $timer.ElapsedMilliseconds $LASTEXITCODE
Get-FileHash -LiteralPath $installerPath,$executable,$bundledPython,(Join-Path $installPath 'resources/app.asar') |
  Select-Object Path,Hash | ConvertTo-Json | Set-Content (Join-Path $evidence 'hashes.json') -Encoding utf8
@{ candidate=(& git rev-parse HEAD); installPath=$installPath; system=(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,OSArchitecture); time=[DateTimeOffset]::Now.ToString('o') } |
  ConvertTo-Json -Depth 5 | Set-Content (Join-Path $evidence 'environment.json') -Encoding utf8
