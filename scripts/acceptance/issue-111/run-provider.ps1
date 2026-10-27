param(
  [Parameter(Mandatory=$true)][string]$State,
  [Parameter(Mandatory=$true)][string]$Node,
  [Parameter(Mandatory=$true)][string]$Python,
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$PrivateKey,
  [string]$Supervisor,
  [string]$Model='agnes-3.0-flash',
  [string]$ConfigRoot='/home/neowyh/code/AgentPlatform',
  [string]$ServerRoot='/home/neowyh/.codex-worktrees/ideer-acceptance111-15aa-20261026'
)
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$State=[IO.Path]::GetFullPath($State)
if(-not $State.StartsWith($root+[IO.Path]::DirectorySeparatorChar) -or (Test-Path $State)){throw 'Fresh workspace state required'}
New-Item -ItemType Directory -Path $State|Out-Null
& $Node (Join-Path $PSScriptRoot '../issue-109/fixture.cjs') $Installer $PrivateKey (Join-Path $State 'installation.json')
if($LASTEXITCODE -ne 0){throw 'NSIS installation failed'}
$meta=Get-Content -Raw (Join-Path $State 'installation.json')|ConvertFrom-Json
$wslRoot='/mnt/'+$root.Substring(0,1).ToLower()+$root.Substring(2).Replace('\','/')
$desktop=Join-Path $State 'desktop';$relative=$desktop.Substring($root.Length).Replace('\','/')
$nonce=[guid]::NewGuid().ToString('N').Substring(0,10);$server=$null;$proxy=$null;$code=1;$supervisedJob=$null
try{
 if($Supervisor){
  $Supervisor=(Resolve-Path -LiteralPath $Supervisor).Path
  if(-not $Supervisor.StartsWith((Join-Path $root 'artifacts/issue-111')+[IO.Path]::DirectorySeparatorChar) -or (Get-Content -Raw (Join-Path $Supervisor 'owner')).Trim() -ne 'ideer111-task-owned'){throw 'Task-owned supervisor required'}
  $supervisedJob=Join-Path $Supervisor ('job-'+$nonce)
  @{mode='provider';desktopState="$wslRoot$relative";model=$Model}|ConvertTo-Json|Set-Content -LiteralPath ($supervisedJob+'.next')
  Move-Item -LiteralPath ($supervisedJob+'.next') -Destination ($supervisedJob+'.json')
 }else{
  $server=Start-Process -FilePath wsl.exe -ArgumentList @('-e','env','PYTHONUNBUFFERED=1',"$ServerRoot/backend/.venv/bin/python","$wslRoot/scripts/acceptance/issue-111/provider-private.py",'--server-root',$ServerRoot,'--config-root',$ConfigRoot,'--state',"/tmp/ideer111-provider-$nonce",'--desktop-state',"$wslRoot$relative",'--model',$Model) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $State 'server.log') -RedirectStandardError (Join-Path $State 'server-error.log')
 }
 $deadline=(Get-Date).AddSeconds(120)
 while(-not(Test-Path (Join-Path $desktop 'ready.json'))){if(($supervisedJob -and (Test-Path ($supervisedJob+'.exit.json'))) -or ($server -and $server.HasExited) -or (Get-Date)-gt$deadline){throw 'Real-provider Gateway readiness failed'};Start-Sleep -Milliseconds 200}
 $proxy=Start-Process -FilePath $Node -ArgumentList @((Join-Path $PSScriptRoot '../issue-109/private-proxy.cjs'),$desktop) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $State 'proxy.log') -RedirectStandardError (Join-Path $State 'proxy-error.log')
 $deadline=(Get-Date).AddSeconds(20)
 while(-not(Test-Path (Join-Path $desktop 'proxy-ready.json'))){if($proxy.HasExited -or (Get-Date)-gt$deadline){throw 'TCP proxy readiness failed'};Start-Sleep -Milliseconds 100}
 & (Join-Path $meta.program 'resources/runtime/python.exe') -I (Join-Path $PSScriptRoot 'provider-profiles.py') prepare $desktop
 if($LASTEXITCODE -ne 0){throw 'Synthetic OS credential preparation failed'}
 $env:DESKTOP_EXECUTABLE=$meta.executable
 & $Python (Join-Path $PSScriptRoot '../issue-101/record_command.py') --output (Join-Path $State 'desktop-command.json') -- $Node (Join-Path $PSScriptRoot 'provider.cjs') $desktop
 $code=$LASTEXITCODE
}finally{
 if(Test-Path $desktop){
  if((Test-Path (Join-Path $desktop 'credential-references.json')) -and -not(Test-Path (Join-Path $desktop 'credential-cleanup.json'))){& (Join-Path $meta.program 'resources/runtime/python.exe') -I (Join-Path $PSScriptRoot '../issue-102/profiles.py') cleanup $desktop;if($LASTEXITCODE -ne 0){$code=1}}
  Set-Content -LiteralPath (Join-Path $desktop 'stop') -Value 'Task-owned real-provider shutdown'
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
