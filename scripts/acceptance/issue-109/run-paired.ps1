param(
  [Parameter(Mandatory=$true)][string]$State,
  [Parameter(Mandatory=$true)][string]$Node,
  [Parameter(Mandatory=$true)][string]$Python,
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$PrivateKey,
  [string]$ServerRoot='/home/neowyh/.codex-worktrees/ideer-complete-105-110-20261025'
)
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$State=[IO.Path]::GetFullPath($State)
if (-not $State.StartsWith($root+[IO.Path]::DirectorySeparatorChar) -or (Test-Path -LiteralPath $State)) { throw 'Fresh workspace state directory required' }
New-Item -ItemType Directory -Path $State | Out-Null
$metaPath=Join-Path $State 'installation.json'
& $Node (Join-Path $PSScriptRoot 'fixture.cjs') $Installer $PrivateKey $metaPath
if ($LASTEXITCODE -ne 0) { throw 'NSIS fixture preparation failed' }
$meta=Get-Content -Raw $metaPath|ConvertFrom-Json
$wslRoot='/mnt/'+$root.Substring(0,1).ToLower()+$root.Substring(2).Replace('\','/')
$desktopState=Join-Path $State 'desktop'
$relative=$desktopState.Substring($root.Length).Replace('\','/')
$nonce=[guid]::NewGuid().ToString('N').Substring(0,10)
$server=$null;$proxy=$null;$code=1
try {
  $server=Start-Process -FilePath wsl.exe -ArgumentList @('-e','env','PYTHONUNBUFFERED=1','SERVER_RELEASE_VERSION=591f80c-runtime-compat-20261025',"$ServerRoot/backend/.venv/bin/python","$wslRoot/scripts/acceptance/issue-109/server-private.py",'--server-root',$ServerRoot,'--state',"/tmp/ideer109-$nonce",'--desktop-state',"$wslRoot$relative") -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $State 'server.log') -RedirectStandardError (Join-Path $State 'server-error.log')
  $deadline=(Get-Date).AddSeconds(90)
  while(-not(Test-Path -LiteralPath (Join-Path $desktopState 'ready.json'))) { if($server.HasExited -or (Get-Date) -gt $deadline){throw 'Real Gateway failed readiness'};Start-Sleep -Milliseconds 200 }
  $proxy=Start-Process -FilePath $Node -ArgumentList @((Join-Path $PSScriptRoot 'private-proxy.cjs'),$desktopState) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $State 'proxy.log') -RedirectStandardError (Join-Path $State 'proxy-error.log')
  $deadline=(Get-Date).AddSeconds(20)
  while(-not(Test-Path -LiteralPath (Join-Path $desktopState 'proxy-ready.json'))) {if($proxy.HasExited -or (Get-Date) -gt $deadline){throw 'Loopback TCP proxy failed readiness'};Start-Sleep -Milliseconds 100}
  & (Join-Path $meta.program 'resources/runtime/python.exe') -I (Join-Path $PSScriptRoot '../issue-102/profiles.py') prepare $desktopState
  if($LASTEXITCODE -ne 0){throw 'Synthetic profile preparation failed'}
  $env:DESKTOP_EXECUTABLE=$meta.executable
  $env:IDEER_ACCEPTANCE_UPDATE_RELEASE=$meta.release
  & $Python (Join-Path $PSScriptRoot '../issue-101/record_command.py') --output (Join-Path $State 'desktop-command.json') -- $Node (Join-Path $PSScriptRoot 'paired.cjs') $desktopState
  $code=$LASTEXITCODE
} finally {
  if(Test-Path -LiteralPath $desktopState){
    if((Test-Path (Join-Path $desktopState 'credential-references.json')) -and -not(Test-Path (Join-Path $desktopState 'credential-cleanup.json'))){& (Join-Path $meta.program 'resources/runtime/python.exe') -I (Join-Path $PSScriptRoot '../issue-102/profiles.py') cleanup $desktopState}
    Set-Content -LiteralPath (Join-Path $desktopState 'stop') -Value 'Task-owned Gateway/proxy shutdown'
  }
  if($server){$exited=$server.WaitForExit(30000);@{exited=$exited;exitCode=if($exited){$server.ExitCode}else{$null}}|ConvertTo-Json|Set-Content (Join-Path $State 'server-process-cleanup.json')}
  if($proxy){$exited=$proxy.WaitForExit(10000);@{exited=$exited;exitCode=if($exited){$proxy.ExitCode}else{$null}}|ConvertTo-Json|Set-Content (Join-Path $State 'proxy-process-cleanup.json')}
}
exit $code
