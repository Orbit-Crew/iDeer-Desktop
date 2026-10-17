param([string]$EvidenceDirectory = 'artifacts/issue-96-windows/supplement')
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null
$EvidenceDirectory = (Resolve-Path -LiteralPath $EvidenceDirectory).Path
$commands = [System.Collections.Generic.List[object]]::new()
function Run-Check([string]$name, [string]$executable, [string[]]$arguments) {
  $startedAt = [DateTimeOffset]::UtcNow
  $timer = [Diagnostics.Stopwatch]::StartNew()
  & $executable @arguments 2>&1 | ForEach-Object { $_.ToString() -replace '(https://[^\s?]+)\?[^\s]+', '$1?[redacted]' } |
    Tee-Object -FilePath (Join-Path $EvidenceDirectory "$name.log")
  $exitCode = $LASTEXITCODE
  $commands.Add([pscustomobject]@{ name = $name; executable = $executable; arguments = $arguments; startedAt = $startedAt.ToString('o'); elapsedMs = $timer.ElapsedMilliseconds; exitCode = $exitCode })
  $commands | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $EvidenceDirectory 'commands.json') -Encoding utf8
  if ($exitCode -ne 0) { throw "$name failed: $exitCode" }
}
$source = Get-Content -LiteralPath 'resources/provenance/linz-source.json' -Raw | ConvertFrom-Json
$snapshotDirectory = Join-Path $EvidenceDirectory 'upstream-snapshot'
$downloadTimer = [Diagnostics.Stopwatch]::StartNew()
foreach ($entry in $source.files.PSObject.Properties) {
  $destination = Join-Path $snapshotDirectory $entry.Name
  New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
  Invoke-WebRequest "https://raw.githubusercontent.com/Neowyh/linz/$($source.commit)/$($entry.Name)" -OutFile $destination
}
@{ repository = $source.repository; commit = $source.commit; files = @($source.files.PSObject.Properties.Name); elapsedMs = $downloadTimer.ElapsedMilliseconds; licenseVerification = 'not performed at user request' } |
  ConvertTo-Json -Depth 5 | Set-Content (Join-Path $EvidenceDirectory 'upstream-download.json') -Encoding utf8
Run-Check 'npm-ci' 'npm.cmd' @('ci', '--no-audit', '--no-fund')
Run-Check 'source' 'npm.cmd' @('run', 'verify:provenance', '--', '--snapshot', $snapshotDirectory)
Run-Check 'typecheck' 'npm.cmd' @('run', 'typecheck')
Run-Check 'test' 'npm.cmd' @('test')
Run-Check 'test-security' 'npm.cmd' @('run', 'test:security')
Run-Check 'dependency-graph' 'node' @('scripts/acceptance-graph.cjs', $EvidenceDirectory)
Run-Check 'dist-win' 'npm.cmd' @('run', 'dist:win')
Copy-Item -LiteralPath 'electron-builder.yml','electron.vite.config.ts','package.json' -Destination $EvidenceDirectory
Get-FileHash 'dist/ideer-desktop-0.1.0-windows-x64-setup.exe','dist/win-unpacked/resources/app.asar','package-lock.json','electron-builder.yml' -Algorithm SHA256 |
  Select-Object Path,Hash | ConvertTo-Json | Set-Content (Join-Path $EvidenceDirectory 'candidate-hashes.json') -Encoding utf8
@{ node = (& node --version); npm = (& npm.cmd --version); head = (& git rev-parse HEAD); builderCache = $env:ELECTRON_BUILDER_CACHE; automaticSigningDiscovery = $env:CSC_IDENTITY_AUTO_DISCOVERY; builderArguments = 'npm.cmd run dist:win (no config overrides)' } |
  ConvertTo-Json | Set-Content (Join-Path $EvidenceDirectory 'build-environment.json') -Encoding utf8
