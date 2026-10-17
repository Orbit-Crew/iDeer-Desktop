param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$InstallDirectory,
  [string]$EvidenceDirectory = 'artifacts/issue-96-windows'
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
Set-Location $repoRoot
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$InstallDirectory = (Resolve-Path -LiteralPath $InstallDirectory).Path
$executable = Join-Path $InstallDirectory 'ideer-desktop.exe'
$uninstaller = Join-Path $InstallDirectory 'Uninstall ideer-desktop.exe'
if (-not (Test-Path -LiteralPath $executable) -or -not (Test-Path -LiteralPath $uninstaller)) {
  throw 'This local acceptance script requires an existing installation to restore.'
}
$registrations = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' |
  Where-Object { $_.DisplayName -eq 'iDeer Desktop' })
if ($registrations.Count -ne 1 -or $registrations[0].UninstallString -notlike "*`"$uninstaller`"*") {
  throw 'The existing current-user installation must match InstallDirectory.'
}
$artifactDir = [IO.Path]::GetFullPath((Join-Path $repoRoot $EvidenceDirectory))
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$wasRunning = @(Get-Process ideer-desktop -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $executable }).Count -gt 0
$fixtureName = "ideer-acceptance-$([guid]::NewGuid()).txt"
$appData = [Environment]::GetFolderPath('ApplicationData')
$legacyDir = Join-Path $appData 'linz'
$desktopDir = Join-Path $appData 'iDeer Desktop'
$legacyExisted = Test-Path -LiteralPath $legacyDir
New-Item -ItemType Directory -Force -Path $legacyDir, $desktopDir | Out-Null
$legacyFixture = Join-Path $legacyDir $fixtureName
$desktopFixture = Join-Path $desktopDir $fixtureName
Set-Content -LiteralPath $legacyFixture -Value 'legacy-data-must-survive' -Encoding utf8
Set-Content -LiteralPath $desktopFixture -Value 'desktop-data-must-survive' -Encoding utf8
$legacySnapshot = @(Get-ChildItem -LiteralPath $legacyDir -File -Recurse | ForEach-Object {
  [pscustomobject]@{ Path = $_.FullName; Hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
})
$results = [System.Collections.Generic.List[object]]::new()
$dataEvidence = [System.Collections.Generic.List[object]]::new()
$timer = [Diagnostics.Stopwatch]::StartNew()
$needsRestore = $false
function Record([string]$name, [string]$detail) {
  $results.Add([pscustomobject]@{ check = $name; result = 'passed'; detail = $detail; timestamp = [DateTimeOffset]::UtcNow.ToString('o'); exitCode = 0; elapsedSeconds = $timer.Elapsed.TotalSeconds })
  Write-Output "PASSED: $name - $detail"
}
function Wait-NoDesktop {
  $deadline = (Get-Date).AddSeconds(20)
  do {
    $remaining = @(Get-Process ideer-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $executable })
    if ($remaining.Count -eq 0) { return }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)
  throw 'Desktop processes remain; refusing to force-terminate them.'
}
function Install-Candidate {
  $process = Start-Process -FilePath $Installer -ArgumentList "/S /D=`"$InstallDirectory`"" -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $executable)) { throw "Install failed: $($process.ExitCode)" }
}
function Assert-Data {
  if ((Get-Content -LiteralPath $desktopFixture -Raw).Trim() -ne 'desktop-data-must-survive') { throw 'Desktop fixture changed' }
  foreach ($entry in $legacySnapshot) {
    if (-not (Test-Path -LiteralPath $entry.Path) -or (Get-FileHash -LiteralPath $entry.Path -Algorithm SHA256).Hash -ne $entry.Hash) {
      throw "Legacy file changed: $($entry.Path)"
    }
  }
}
function Save-DataEvidence([string]$stage) {
  $dataEvidence.Add([pscustomobject]@{
    stage = $stage
    timestamp = [DateTimeOffset]::UtcNow.ToString('o')
    files = @(Get-FileHash -LiteralPath $legacyFixture, $desktopFixture -Algorithm SHA256 | Select-Object Path,Hash)
    legacyFiles = $legacySnapshot
    expectedContents = @{ legacy = 'legacy-data-must-survive'; desktop = 'desktop-data-must-survive' }
    coverage = 'Unique test fixtures only; not a real installed linz or historical workspace'
  })
  $dataEvidence | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $artifactDir 'data-retention.json') -Encoding utf8
}
function Assert-Shortcuts {
  $shell = New-Object -ComObject WScript.Shell
  foreach ($shortcut in @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'iDeer Desktop.lnk'),
    (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs/iDeer Desktop.lnk')
  )) {
    if (-not (Test-Path -LiteralPath $shortcut)) { throw "Missing shortcut: $shortcut" }
    if ($shell.CreateShortcut($shortcut).TargetPath -ne $executable) { throw "Wrong shortcut target: $shortcut" }
  }
}
try {
  Save-DataEvidence 'before-install'
  foreach ($process in @(Get-Process ideer-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $executable -and $_.MainWindowHandle -ne 0 })) {
    if (-not $process.CloseMainWindow()) { throw 'Could not gracefully close existing Desktop' }
  }
  Wait-NoDesktop
  $needsRestore = $true
  Install-Candidate
  $needsRestore = $false
  Record 'install' "Installed candidate to $InstallDirectory"
  Assert-Shortcuts
  Record 'shortcuts' 'Desktop and Start Menu shortcuts target the installed executable'
  $installedHash = (Get-FileHash -LiteralPath (Join-Path $InstallDirectory 'resources/app.asar') -Algorithm SHA256).Hash
  $candidateHash = (Get-FileHash -LiteralPath (Join-Path $repoRoot 'dist/win-unpacked/resources/app.asar') -Algorithm SHA256).Hash
  if ($installedHash -ne $candidateHash) { throw 'Installed asar differs from candidate' }
  Record 'installed-candidate' $installedHash
  $env:DESKTOP_EXECUTABLE = $executable
  $env:DESKTOP_EVIDENCE_DIR = $artifactDir
  Save-DataEvidence 'after-install'
  $smokeTimer = [Diagnostics.Stopwatch]::StartNew()
  & node 'scripts/desktop-smoke.cjs' 2>&1 | Tee-Object -FilePath (Join-Path $artifactDir 'installed-desktop-smoke.log')
  if ($LASTEXITCODE -ne 0) { throw 'Installed desktop smoke failed' }
  Wait-NoDesktop
  Copy-Item -LiteralPath (Join-Path $artifactDir 'desktop-startup.png') -Destination (Join-Path $artifactDir 'installed-desktop-startup.png')
  @{ command = 'node scripts/desktop-smoke.cjs'; executable = $executable; exitCode = 0; elapsedMs = $smokeTimer.ElapsedMilliseconds } |
    ConvertTo-Json | Set-Content (Join-Path $artifactDir 'desktop-command.json') -Encoding utf8
  Record 'installed-desktop-smoke' 'Real Electron UI, sandbox, IPC, CSP, sidebar, UI quit and native close'
  Assert-Data
  $needsRestore = $true
  $process = Start-Process -FilePath $uninstaller -ArgumentList '/currentuser', '/S' -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Uninstall failed: $($process.ExitCode)" }
  $deadline = (Get-Date).AddSeconds(30)
  while ((Test-Path -LiteralPath $executable) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
  if (Test-Path -LiteralPath $executable) { throw 'Executable remains after uninstall' }
  Assert-Data
  Save-DataEvidence 'after-uninstall'
  Record 'uninstall-data-retention' 'Executable removed; Desktop fixture and all original linz files preserved'
  Install-Candidate
  $needsRestore = $false
  Assert-Data
  Assert-Shortcuts
  Save-DataEvidence 'after-reinstall'
  Record 'reinstall-data-retention' 'Reinstalled at original location with data and shortcuts retained'
  # Visible shortcut/window acceptance is performed interactively after this script.
  # A hidden Start-Process window cannot be validated using MainWindowTitle.
} catch {
  $results.Add([pscustomobject]@{ check = 'acceptance'; result = 'failed'; detail = $_.Exception.Message })
  throw
} finally {
  try {
    if ($needsRestore) { Install-Candidate }
    if ($wasRunning -and -not @(Get-Process ideer-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $executable }).Count) {
      Start-Process -FilePath $executable -WindowStyle Hidden
    }
    Assert-Data
    Remove-Item -LiteralPath $legacyFixture, $desktopFixture
    if (-not $legacyExisted -and @(Get-ChildItem -LiteralPath $legacyDir -Force).Count -eq 0) { Remove-Item -LiteralPath $legacyDir }
  } finally {
    $results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $artifactDir 'lifecycle-results.json') -Encoding utf8
  }
}
