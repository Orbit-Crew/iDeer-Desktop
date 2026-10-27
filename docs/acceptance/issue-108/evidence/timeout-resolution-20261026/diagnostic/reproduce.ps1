param([int]$Tries=5, [switch]$Timing)
$ErrorActionPreference='Stop'
$root=$PWD.Path
$node='C:\Users\Neo\.codex\worktrees\5435\iDeer-Desktop\.cache\toolchains\node-v22.14.0-win-x64\node.exe'
$meta=Get-Content -Raw artifacts/issue-108/supplement/online-c-install.json|ConvertFrom-Json
$program=[IO.Path]::GetFullPath($meta.program)
if (-not $program.StartsWith([IO.Path]::GetFullPath($env:TEMP)+[IO.Path]::DirectorySeparatorChar) -or (Split-Path $program -Leaf) -notlike 'ideer108-*') { throw 'Test program escaped TEMP fixture root' }
if (-not (Test-Path -LiteralPath $meta.executable)) { throw 'Previously installed test candidate missing' }
$serverRoot='/home/neowyh/.codex-worktrees/ideer-complete-105-110-20261025'
$wslRoot='/mnt/c/Users/Neo/.codex/worktrees/15aa/iDeer-Desktop'
foreach($iteration in 1..$Tries) {
  if (@(Get-CimInstance Win32_Process | Where-Object ExecutablePath -eq $meta.executable).Count) { throw 'Previous fixture process still running' }
  Copy-Item -LiteralPath dist/win-unpacked/resources/runtime/core/tray.py -Destination (Join-Path $program 'resources/runtime/core/tray.py')
  $nonce=[guid]::NewGuid().ToString('N').Substring(0,8)
  $state=Join-Path $root "artifacts/issue-108/timeout/r-$nonce"
  $stdout=Join-Path $root "artifacts/issue-108/timeout/r-$nonce-server.log"
  $stderr=Join-Path $root "artifacts/issue-108/timeout/r-$nonce-server-error.log"
  $server=Start-Process -FilePath wsl.exe -ArgumentList @('-e','env','PYTHONUNBUFFERED=1',"UPDATES_CONTROLLED_DIR=$wslRoot/artifacts/issue-108/supplement/published-v2",'SERVER_RELEASE_VERSION=591f80c-runtime-compat-20261025',"$serverRoot/backend/.venv/bin/python","$wslRoot/scripts/acceptance/issue-102/server_fixture.py",'--server-root',$serverRoot,'--state',"/tmp/i108-r-$nonce",'--desktop-state',"$wslRoot/artifacts/issue-108/timeout/r-$nonce") -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  try {
    $deadline=(Get-Date).AddSeconds(90)
    while(-not(Test-Path (Join-Path $state 'ready.json'))) {
      if($server.HasExited -or (Get-Date) -gt $deadline) { throw "Server not ready: $nonce" }
      Start-Sleep -Milliseconds 200
    }
    & (Join-Path $program 'resources/runtime/python.exe') -I scripts/acceptance/issue-102/profiles.py prepare $state
    if($LASTEXITCODE -ne 0) { throw 'Profile preparation failed' }
    $env:DESKTOP_EXECUTABLE=$meta.executable
    $env:IDEER_ACCEPTANCE_UPDATE_RELEASE=Join-Path $root 'artifacts/issue-108/supplement/published-v2/desktop/manifest.json'
    $env:IDEER_ACCEPTANCE_UPDATE_SOURCE='online'
    if ($Timing) { $env:IDEER_ACCEPTANCE_STATUS_BARRIER=Join-Path $state 'timing-barrier' }
    else { Remove-Item Env:IDEER_ACCEPTANCE_STATUS_BARRIER -ErrorAction SilentlyContinue }
    python scripts/acceptance/issue-101/record_command.py --output "artifacts/issue-108/timeout/r-$nonce-command.json" -- $node scripts/acceptance/issue-108/acceptance.cjs $state
    $code=$LASTEXITCODE
    $result=Get-Content -Raw (Join-Path $state 'result.json')|ConvertFrom-Json
    @{iteration=$iteration;id=$nonce;exitCode=$code;status=$result.status;error=$result.error;observations=$result.maintenanceObservations}|ConvertTo-Json -Depth 5 -Compress
    if($code -ne 0 -and $result.maintenanceObservations) { exit $code }
  } finally {
    if(Test-Path -LiteralPath $state) { Set-Content -LiteralPath (Join-Path $state 'stop') -Value 'isolated test cleanup' }
    $server.WaitForExit(30000)|Out-Null
  }
}
