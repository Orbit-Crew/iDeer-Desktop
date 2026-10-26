param(
  [Parameter(Mandatory=$true)][ValidateSet('matrix','writes','identity','artifacts','recovery','online','offline')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$State,
  [Parameter(Mandatory=$true)][string]$Node,
  [Parameter(Mandatory=$true)][string]$Python,
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$PrivateKey,
  [string]$ReleaseManifest,
  [string]$Supervisor,
  [string]$ServerRoot='/home/neowyh/.codex-worktrees/ideer-acceptance111-15aa-20261026'
)
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$State=[IO.Path]::GetFullPath($State)
if (-not $State.StartsWith($root+[IO.Path]::DirectorySeparatorChar) -or (Test-Path -LiteralPath $State)) { throw 'Fresh workspace state required' }
New-Item -ItemType Directory -Path $State | Out-Null
& $Node (Join-Path $PSScriptRoot '../issue-109/fixture.cjs') $Installer $PrivateKey (Join-Path $State 'installation.json')
if($LASTEXITCODE -ne 0){throw 'Fresh NSIS installation failed'}
$meta=Get-Content -Raw (Join-Path $State 'installation.json')|ConvertFrom-Json
$wslRoot='/mnt/'+$root.Substring(0,1).ToLower()+$root.Substring(2).Replace('\','/')
$desktopState=Join-Path $State 'desktop'
$relative=$desktopState.Substring($root.Length).Replace('\','/')
$nonce=[guid]::NewGuid().ToString('N').Substring(0,10)
$server=$null;$proxy=$null;$code=1;$supervisedJob=$null;$updates=''
try {
  $serverEnv=@('-e','env','PYTHONUNBUFFERED=1','SERVER_RELEASE_VERSION=591f80c-runtime-compat-20261025')
  if($Mode -in @('online','offline')) {
    if(-not $ReleaseManifest){throw 'Pass a signed changed release for update modes'}
    $releaseRoot=[IO.Path]::GetFullPath((Split-Path (Split-Path $ReleaseManifest)))
    if(-not $releaseRoot.StartsWith($root+[IO.Path]::DirectorySeparatorChar)){throw 'Release must be in the task workspace'}
    $updates=$wslRoot+$releaseRoot.Substring($root.Length).Replace('\','/')
    $serverEnv+=('UPDATES_CONTROLLED_DIR='+$updates)
  }
  if($Supervisor){
    $Supervisor=(Resolve-Path -LiteralPath $Supervisor).Path
    if(-not $Supervisor.StartsWith((Join-Path $root 'artifacts/issue-111')+[IO.Path]::DirectorySeparatorChar) -or (Get-Content -Raw (Join-Path $Supervisor 'owner')).Trim() -ne 'ideer111-task-owned'){throw 'Task-owned supervisor required'}
    $supervisedJob=Join-Path $Supervisor ('job-'+$nonce)
    @{mode='base';desktopState="$wslRoot$relative";updates=$updates}|ConvertTo-Json|Set-Content -LiteralPath ($supervisedJob+'.next')
    Move-Item -LiteralPath ($supervisedJob+'.next') -Destination ($supervisedJob+'.json')
  }else{
    $server=Start-Process -FilePath wsl.exe -ArgumentList ($serverEnv+@("$ServerRoot/backend/.venv/bin/python","$wslRoot/scripts/acceptance/issue-109/server-private.py",'--server-root',$ServerRoot,'--state',"/tmp/ideer111-$nonce",'--desktop-state',"$wslRoot$relative")) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $State 'server.log') -RedirectStandardError (Join-Path $State 'server-error.log')
  }
  $deadline=(Get-Date).AddSeconds(120)
  while(-not(Test-Path (Join-Path $desktopState 'ready.json'))){if(($supervisedJob -and (Test-Path ($supervisedJob+'.exit.json'))) -or ($server -and $server.HasExited) -or (Get-Date)-gt$deadline){throw 'Real Gateway failed readiness'};Start-Sleep -Milliseconds 200}
  $proxy=Start-Process -FilePath $Node -ArgumentList @((Join-Path $PSScriptRoot '../issue-109/private-proxy.cjs'),$desktopState) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $State 'proxy.log') -RedirectStandardError (Join-Path $State 'proxy-error.log')
  $deadline=(Get-Date).AddSeconds(20)
  while(-not(Test-Path (Join-Path $desktopState 'proxy-ready.json'))){if($proxy.HasExited -or (Get-Date)-gt$deadline){throw 'TCP proxy failed readiness'};Start-Sleep -Milliseconds 100}
  & (Join-Path $meta.program 'resources/runtime/python.exe') -I (Join-Path $PSScriptRoot '../issue-102/profiles.py') prepare $desktopState
  if($LASTEXITCODE -ne 0){throw 'Synthetic profile preparation failed'}
  $env:DESKTOP_EXECUTABLE=$meta.executable
  $env:IDEER_T111_MODE=$Mode
  $env:IDEER_ACCEPTANCE_UPDATE_RELEASE=if($ReleaseManifest){$ReleaseManifest}else{$meta.release}
  if($Mode -in @('online','offline')){$env:IDEER_ACCEPTANCE_UPDATE_SOURCE=$Mode}
  Remove-Item Env:IDEER_ACCEPTANCE_STATUS_BARRIER -ErrorAction SilentlyContinue
  $driver=switch($Mode){
    'matrix' {Join-Path $PSScriptRoot 'desktop.cjs'}
    'writes' {Join-Path $PSScriptRoot 'composed.cjs'}
    'identity' {Join-Path $PSScriptRoot 'composed.cjs'}
    'artifacts' {Join-Path $PSScriptRoot '../issue-105/desktop.cjs'}
    'recovery' {Join-Path $PSScriptRoot '../issue-109/paired.cjs'}
    default {Join-Path $PSScriptRoot '../issue-108/acceptance.cjs'}
  }
  & $Python (Join-Path $PSScriptRoot '../issue-101/record_command.py') --output (Join-Path $State 'desktop-command.json') -- $Node $driver $desktopState
  $code=$LASTEXITCODE
  if(Test-Path (Join-Path $desktopState 'result.json')){
    $completed=Get-Content -Raw (Join-Path $desktopState 'result.json')|ConvertFrom-Json
    if($completed.status -ne 'passed'){$code=1}
    # The identity flow retires credentials through its lifecycle helper,
    # which handles references already removed by logout/rotation. Persist
    # that actual result so the generic fallback does not delete them again.
    if($Mode -eq 'identity' -and $completed.credentialCleanup -and -not $completed.cleanupError){
      $completed.credentialCleanup|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $desktopState 'credential-cleanup.json')
    }
  }
} finally {
  if(Test-Path $desktopState){
    if((Test-Path (Join-Path $desktopState 'credential-references.json')) -and -not(Test-Path (Join-Path $desktopState 'credential-cleanup.json'))){
      $identityConfig=Join-Path $desktopState 'appdata/iDeer Desktop/Runtime/settings.json'
      if($Mode -eq 'identity' -and (Test-Path $identityConfig)){
        & (Join-Path $meta.program 'resources/runtime/python.exe') -I (Join-Path $PSScriptRoot '../issue-103/lifecycle.py') cleanup $desktopState $identityConfig A
      }else{
        & (Join-Path $meta.program 'resources/runtime/python.exe') -I (Join-Path $PSScriptRoot '../issue-102/profiles.py') cleanup $desktopState
      }
      if($LASTEXITCODE -ne 0){$code=1}
    }
    Set-Content -LiteralPath (Join-Path $desktopState 'stop') -Value 'Task-owned fixture shutdown'
  }
  foreach($entry in @(@{Name='server';Process=$server},@{Name='proxy';Process=$proxy})){
    if($entry.Process){$exited=$entry.Process.WaitForExit(30000);@{exited=$exited;exitCode=if($exited){$entry.Process.ExitCode}else{$null}}|ConvertTo-Json|Set-Content (Join-Path $State ($entry.Name+'-process-cleanup.json'));if(-not $exited -or $entry.Process.ExitCode -ne 0){$code=1}}
  }
  if($supervisedJob){
    $deadline=(Get-Date).AddSeconds(40)
    while(-not(Test-Path ($supervisedJob+'.exit.json')) -and (Get-Date)-lt$deadline){Start-Sleep -Milliseconds 100}
    if(Test-Path ($supervisedJob+'.exit.json')){Copy-Item -LiteralPath ($supervisedJob+'.exit.json') -Destination (Join-Path $State 'server-process-cleanup.json');$closed=Get-Content -Raw ($supervisedJob+'.exit.json')|ConvertFrom-Json;if($closed.exitCode -ne 0){$code=1}}else{$code=1}
  }
}
exit $code
