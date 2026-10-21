param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$InstallDirectory,
  [string]$EvidenceDirectory = 'artifacts/issue-101/lifecycle'
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$InstallDirectory = (Resolve-Path -LiteralPath $InstallDirectory).Path
$dataRoot = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'iDeer Desktop'
$profile = [IO.Path]::GetFullPath((Join-Path $dataRoot 'Runtime'))
$backup = [IO.Path]::GetFullPath((Join-Path $dataRoot ('Runtime.issue101-lifecycle-' + [guid]::NewGuid().ToString('N'))))
if ([IO.Path]::GetDirectoryName($profile) -ne $dataRoot -or [IO.Path]::GetDirectoryName($backup) -ne $dataRoot) {
  throw 'Runtime acceptance paths must stay inside the known iDeer Desktop data folder'
}
if (@(Get-Process ideer-desktop -ErrorAction SilentlyContinue).Count) {
  throw 'Close Desktop before running the isolated installation lifecycle'
}
function Profile-Hashes([string]$directory) {
  $hashes = @{}
  if (Test-Path -LiteralPath $directory) {
    Get-ChildItem -LiteralPath $directory -File -Recurse | ForEach-Object {
      $hashes[$_.FullName.Substring($directory.Length)] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }
  }
  return $hashes
}
$before = Profile-Hashes $profile
$existed = Test-Path -LiteralPath $profile
if ($existed) {
  if ((Get-Item -LiteralPath $profile).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Refusing a Runtime profile reparse point'
  }
  Move-Item -LiteralPath $profile -Destination $backup
}
$nonce = [guid]::NewGuid().ToString('N')
$marker = Join-Path $profile '.issue101-lifecycle-owner'
try {
  New-Item -ItemType Directory -Path $profile | Out-Null
  Set-Content -LiteralPath $marker -Value $nonce -Encoding utf8
  & (Join-Path $repoRoot 'scripts/windows-local-acceptance.ps1') -Installer $Installer `
    -InstallDirectory $InstallDirectory -EvidenceDirectory $EvidenceDirectory
} finally {
  if (@(Get-Process ideer-desktop -ErrorAction SilentlyContinue).Count) {
    throw "Desktop remains running; original Runtime profile is preserved at $backup"
  }
  if (Test-Path -LiteralPath $profile) {
    if (-not (Test-Path -LiteralPath $marker) -or (Get-Content -LiteralPath $marker -Raw).Trim() -ne $nonce) {
      throw "Acceptance profile ownership changed; original profile is preserved at $backup"
    }
    if ([IO.Path]::GetFullPath($profile) -ne (Join-Path $dataRoot 'Runtime')) {
      throw 'Unexpected acceptance profile cleanup path'
    }
    Remove-Item -LiteralPath $profile -Recurse -Force
  }
  if ($existed) { Move-Item -LiteralPath $backup -Destination $profile }
  $after = Profile-Hashes $profile
  if ($before.Count -ne $after.Count) { throw 'Restored Runtime profile file count changed' }
  foreach ($relative in $before.Keys) {
    if ($before[$relative] -ne $after[$relative]) { throw 'Restored Runtime profile hash changed' }
  }
  $evidence = [IO.Path]::GetFullPath((Join-Path $repoRoot $EvidenceDirectory))
  New-Item -ItemType Directory -Force -Path $evidence | Out-Null
  @{ restored = $true; originallyExisted = $existed; unchangedFiles = $before.Count; appClosed = $true } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'profile-restoration.json') -Encoding utf8
}
