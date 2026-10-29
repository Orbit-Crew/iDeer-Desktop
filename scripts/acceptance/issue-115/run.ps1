param(
  [Parameter(Mandatory=$true)][string]$State,
  [Parameter(Mandatory=$true)][string]$Installer,
  [string]$Node='G:\code\iDeer-worktrees\.tools\node-v22.14.0-win-x64\node.exe',
  [string]$ServerRoot='/mnt/g/code/iDeer-Desktop/.worktree/acceptance-112-123/server-candidate',
  [string]$ServerPython='/home/neowyh/orch-worktrees/issue-112-server/backend/.venv/bin/python'
)
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$State=[IO.Path]::GetFullPath($State)
if(-not $State.StartsWith((Join-Path $root 'artifacts/issue-115')+[IO.Path]::DirectorySeparatorChar) -or (Test-Path -LiteralPath $State)){throw 'Fresh task-owned artifact directory required'}
New-Item -ItemType Directory -Path $State -Force | Out-Null
$server=$null;$proxy=$null;$meta=$null;$code=1
$desktop=Join-Path $State 'desktop'
$linuxRoot='/mnt/'+$root.Substring(0,1).ToLower()+$root.Substring(2).Replace('\','/')
$linuxDesktop='/mnt/'+$desktop.Substring(0,1).ToLower()+$desktop.Substring(2).Replace('\','/')
$nonce=[guid]::NewGuid().ToString('N').Substring(0,12)
$record=@{startedAt=(Get-Date).ToUniversalTime().ToString('o');serverRoot=$ServerRoot;serverPython=$ServerPython;node=$Node;installer=$Installer;state=$State;steps=@()}
try {
  & $Node (Join-Path $PSScriptRoot '../issue-112/install.cjs') $Installer (Join-Path $State 'installation.json')
  if($LASTEXITCODE -ne 0){throw 'Actual NSIS installation failed'}
  $meta=Get-Content -Raw (Join-Path $State 'installation.json') | ConvertFrom-Json
  $record.steps+=@{name='install';exitCode=0}
  $candidatePythonPath="$ServerRoot/backend`:$ServerRoot/backend/tests`:$ServerRoot/backend/packages/harness`:$ServerRoot/backend/packages/agentplatform-extension`:$ServerRoot/backend/packages/extension-api"
  $server=Start-Process -FilePath wsl.exe -ArgumentList @('-d','Ubuntu','-e','env','PYTHONUNBUFFERED=1','SERVER_RELEASE_VERSION=591f80c-runtime-compat-20261025',"PYTHONPATH=$candidatePythonPath","$ServerPython","$linuxRoot/scripts/acceptance/issue-115/server.py",'--server-root',$ServerRoot,'--state',"/tmp/ideer115-$nonce",'--desktop-state',$linuxDesktop) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $State 'server.log') -RedirectStandardError (Join-Path $State 'server-error.log')
  $deadline=(Get-Date).AddSeconds(150)
  while(-not(Test-Path (Join-Path $desktop 'ready.json'))){
    if($server.HasExited -or (Get-Date)-gt$deadline){throw 'Real Gateway readiness failed'}
    Start-Sleep -Milliseconds 200
  }
  $proxy=Start-Process -FilePath $Node -ArgumentList @((Join-Path $PSScriptRoot '../issue-109/private-proxy.cjs'),$desktop) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $State 'proxy.log') -RedirectStandardError (Join-Path $State 'proxy-error.log')
  $deadline=(Get-Date).AddSeconds(30)
  while(-not(Test-Path (Join-Path $desktop 'proxy-ready.json'))){if($proxy.HasExited -or (Get-Date)-gt$deadline){throw 'Raw TCP readiness failed'};Start-Sleep -Milliseconds 100}
  & (Join-Path $meta.program 'resources/runtime/python.exe') -I (Join-Path $PSScriptRoot '../issue-102/profiles.py') prepare $desktop
  if($LASTEXITCODE -ne 0){throw 'Real login/device pairing and OS credential preparation failed'}
  $record.steps+=@{name='real-profile-prepare';exitCode=0}
  & $Node (Join-Path $PSScriptRoot 'desktop.cjs') $desktop
  $code=$LASTEXITCODE
  if(Test-Path (Join-Path $desktop 'result.json')){if((Get-Content -Raw (Join-Path $desktop 'result.json') | ConvertFrom-Json).status -ne 'passed'){$code=1}}
  $record.steps+=@{name='installed-scenarios';exitCode=$code}
} catch {
  $record.error=$_.Exception.Message
  $code=1
} finally {
  if(Test-Path $desktop){
    if($meta -and (Test-Path (Join-Path $desktop 'credential-references.json')) -and -not(Test-Path (Join-Path $desktop 'credential-cleanup.json'))){
      & (Join-Path $meta.program 'resources/runtime/python.exe') -I (Join-Path $PSScriptRoot '../issue-102/profiles.py') cleanup $desktop
      if($LASTEXITCODE -ne 0){$code=1}
    }
    Set-Content -LiteralPath (Join-Path $desktop 'stop') -Value 'Task-owned fixture shutdown'
  }
  foreach($entry in @(@{name='server';process=$server},@{name='proxy';process=$proxy})){
    if($entry.process){
      $exited=$entry.process.WaitForExit(30000)
      $exitCode=if($exited){$entry.process.ExitCode}else{$null}
      $record.steps+=@{name=$entry.name+'-cleanup';exited=$exited;exitCode=$exitCode}
      if(-not $exited -or $exitCode -ne 0){$code=1}
    }
  }
  if($meta){
    $resolved=[IO.Path]::GetFullPath($meta.program)
    if(-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath())) -or -not (Split-Path $resolved -Leaf).StartsWith('ideer112-installed-')){throw 'Uninstaller is outside task-owned installation'}
    $uninstall=Start-Process -FilePath (Join-Path $resolved 'Uninstall ideer-desktop.exe') -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
    $record.steps+=@{name='uninstall';exitCode=$uninstall.ExitCode}
    if($uninstall.ExitCode -ne 0){$code=1}
    $deadline=(Get-Date).AddSeconds(30)
    while((Test-Path $meta.executable) -and (Get-Date)-lt$deadline){Start-Sleep -Milliseconds 100}
    if(Test-Path $meta.executable){$code=1;$record.uninstallError='Actual executable still exists'}
  }
  $record.finishedAt=(Get-Date).ToUniversalTime().ToString('o');$record.exitCode=$code
  $record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $State 'command.json')
}
exit $code
