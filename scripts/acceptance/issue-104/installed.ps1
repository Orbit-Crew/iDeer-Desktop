param(
  [Parameter(Mandatory = $true)][string]$State,
  [Parameter(Mandatory = $true)][string]$Executable,
  [string]$Node
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
$State = (Resolve-Path -LiteralPath $State).Path
$Executable = (Resolve-Path -LiteralPath $Executable).Path
if (-not $Node) {
  $candidate = @(Get-ChildItem -LiteralPath (Join-Path $repoRoot '.cache/node22') -Filter node.exe -File -Recurse)
  if ($candidate.Count -ne 1) { throw 'Pass the absolute Node executable with -Node' }
  $Node = $candidate[0].FullName
}
$Node = (Resolve-Path -LiteralPath $Node).Path
$knownAppData = [Environment]::GetFolderPath('ApplicationData')
if ([IO.Path]::GetFullPath($env:APPDATA) -ne [IO.Path]::GetFullPath($knownAppData)) { throw 'APPDATA differs from Windows Known Folder' }
$dataRoot = [IO.Path]::GetFullPath((Join-Path $knownAppData 'iDeer Desktop'))
$runtimeProfile = [IO.Path]::GetFullPath((Join-Path $dataRoot 'Runtime'))
$backup = [IO.Path]::GetFullPath((Join-Path $dataRoot ('Runtime.issue102-' + [guid]::NewGuid())))
if ([IO.Path]::GetDirectoryName($runtimeProfile) -ne $dataRoot -or [IO.Path]::GetDirectoryName($backup) -ne $dataRoot) {
  throw 'Profile paths must stay inside iDeer Desktop Known Folder'
}
if (@(Get-Process ideer-desktop -ErrorAction SilentlyContinue).Count) { throw 'Quit the installed Desktop before isolated acceptance' }
function Profile-Hashes([string]$Directory) {
  $hashes = @{}
  if (Test-Path -LiteralPath $Directory) {
    if ((Get-Item -LiteralPath $Directory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a Runtime profile reparse point' }
    Get-ChildItem -LiteralPath $Directory -File -Recurse | ForEach-Object {
      $hashes[$_.FullName.Substring($Directory.Length)] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }
  }
  return $hashes
}
$before = Profile-Hashes $runtimeProfile
$existed = Test-Path -LiteralPath $runtimeProfile
if ($existed) { Move-Item -LiteralPath $runtimeProfile -Destination $backup }
$nonce = [guid]::NewGuid().ToString()
$ownership = Join-Path $runtimeProfile '.issue102-owner'
$previousExecutable = $env:DESKTOP_EXECUTABLE
$status = 1
try {
  New-Item -ItemType Directory -Path $runtimeProfile | Out-Null
  Set-Content -LiteralPath $ownership -Value $nonce -Encoding utf8
  $env:DESKTOP_EXECUTABLE = $Executable
  & $Node (Join-Path $PSScriptRoot 'desktop.cjs') $State
  $status = $LASTEXITCODE
} finally {
  if ($null -eq $previousExecutable) { Remove-Item Env:DESKTOP_EXECUTABLE -ErrorAction SilentlyContinue }
  else { $env:DESKTOP_EXECUTABLE = $previousExecutable }
  if (@(Get-Process ideer-desktop -ErrorAction SilentlyContinue).Count) { throw "Desktop remains running; original profile preserved at $backup" }
  if (Test-Path -LiteralPath $runtimeProfile) {
    if (-not (Test-Path -LiteralPath $ownership) -or (Get-Content -LiteralPath $ownership -Raw).Trim() -ne $nonce) {
      throw "Profile ownership changed; original preserved at $backup"
    }
    $settings = Join-Path $runtimeProfile 'settings.json'
    if (Test-Path -LiteralPath $settings) {
      $references = @(Get-Content -LiteralPath (Join-Path $State 'credential-references.json') -Raw | ConvertFrom-Json)
      $active = Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json
      if ($active.business_token_ref -notin $references) { throw "Profile identity changed; original preserved at $backup" }
    }
    if ([IO.Path]::GetFullPath($runtimeProfile) -ne (Join-Path $dataRoot 'Runtime')) { throw 'Unexpected synthetic profile cleanup path' }
    Remove-Item -LiteralPath $runtimeProfile -Recurse -Force
  }
  if ($existed) { Move-Item -LiteralPath $backup -Destination $runtimeProfile }
  $after = Profile-Hashes $runtimeProfile
  if ($before.Count -ne $after.Count) { throw 'Restored Runtime file count changed' }
  foreach ($relative in $before.Keys) {
    if ($before[$relative] -ne $after[$relative]) { throw 'Restored Runtime file hash changed' }
  }
  @{ restored = $true; originallyExisted = $existed; unchangedFiles = $before.Count; appClosed = $true;
     profile = 'existing current-user Runtime'; acceptanceExitCode = $status; before = $before; after = $after } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $State 'profile-restoration.json') -Encoding utf8
}
exit $status
