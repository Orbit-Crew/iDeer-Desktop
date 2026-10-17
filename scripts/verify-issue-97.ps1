param([string]$PythonExecutable = 'python', [string]$EvidenceDirectory = 'artifacts/issue-97')
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null
$commands = [System.Collections.Generic.List[object]]::new()
function Check([string]$name, [string]$executable, [string[]]$arguments) {
  $started = [DateTimeOffset]::Now
  $timer = [Diagnostics.Stopwatch]::StartNew()
  & $executable @arguments 2>&1 | ForEach-Object { $_.ToString() -replace '(https://[^\s?]+)\?[^\s]+', '$1?[redacted]' } |
    Tee-Object -FilePath (Join-Path $EvidenceDirectory "$name.log")
  $result = $LASTEXITCODE
  $commands.Add(@{ name=$name; executable=$executable; arguments=$arguments; startedAt=$started.ToString('o'); elapsedMs=$timer.ElapsedMilliseconds; exitCode=$result })
  $commands | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $EvidenceDirectory 'commands.json') -Encoding utf8
  if ($result -ne 0) { throw "$name failed ($result)" }
}
$env:PYTHONPATH=(Resolve-Path local-runtime).Path
$env:IDEER_TEST_EVIDENCE=[IO.Path]::GetFullPath($EvidenceDirectory)
Check 'runtime-source' $PythonExecutable @('scripts/verify-runtime-source.py')
Check 'runtime-static' $PythonExecutable @('-m','ruff','check','local-runtime','--select','E9,F63,F7,F82')
Check 'runtime-prepare' $PythonExecutable @('scripts/prepare-runtime.py')
Check 'typecheck' 'npm.cmd' @('run','typecheck')
Check 'runtime-tests' $PythonExecutable @('-m','pytest','local-runtime/tests','-q',"--junitxml=$EvidenceDirectory/runtime-tests.xml")
Check 'desktop-tests' 'npm.cmd' @('test')
Check 'graph' 'node' @('scripts/acceptance-graph.cjs',$EvidenceDirectory)
Check 'dist-win' 'npm.cmd' @('run','dist:win')
Get-FileHash 'dist/ideer-desktop-0.1.0-windows-x64-setup.exe','dist/win-unpacked/resources/app.asar','package-lock.json','local-runtime/distribution.lock.json' |
  Select-Object Path,Hash | ConvertTo-Json | Set-Content (Join-Path $EvidenceDirectory 'hashes.json') -Encoding utf8
@{ candidate=(& git rev-parse HEAD); changes=(& git status --porcelain); node=(& node --version); npm=(& npm.cmd --version); python=(& $PythonExecutable --version); system=(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,OSArchitecture); time=[DateTimeOffset]::Now.ToString('o') } |
  ConvertTo-Json -Depth 5 | Set-Content (Join-Path $EvidenceDirectory 'environment.json') -Encoding utf8
