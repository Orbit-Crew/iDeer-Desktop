param(
  [Parameter(Mandatory = $true)][string]$State,
  [string]$Executable = 'D:\software\iDeer Desktop\ideer-desktop\ideer-desktop.exe'
)
$ErrorActionPreference = 'Stop'
$State = (Resolve-Path -LiteralPath $State).Path
$Executable = (Resolve-Path -LiteralPath $Executable).Path
$knownAppData = [Environment]::GetFolderPath('ApplicationData')
if ([IO.Path]::GetFullPath($env:APPDATA) -ne [IO.Path]::GetFullPath($knownAppData)) { throw 'APPDATA differs from Windows Known Folder' }
$dataRoot = Join-Path $knownAppData 'iDeer Desktop'
$runtimeProfile = [IO.Path]::GetFullPath((Join-Path $dataRoot 'Runtime'))
$backup = [IO.Path]::GetFullPath((Join-Path $dataRoot ('Runtime.issue100-' + [guid]::NewGuid())))
if ([IO.Path]::GetDirectoryName($runtimeProfile) -ne $dataRoot -or [IO.Path]::GetDirectoryName($backup) -ne $dataRoot) {
  throw 'Profile paths must stay inside iDeer Desktop appData'
}
if (@(Get-Process ideer-desktop -ErrorAction SilentlyContinue).Count) {
  throw 'Quit the installed Desktop before isolated acceptance'
}
$before = @{}
if (Test-Path -LiteralPath $runtimeProfile) {
  Get-ChildItem -LiteralPath $runtimeProfile -File -Recurse | ForEach-Object {
    $before[$_.FullName.Substring($runtimeProfile.Length)] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
  }
  Move-Item -LiteralPath $runtimeProfile -Destination $backup
}
$moved = Test-Path -LiteralPath $backup
$nonce = [guid]::NewGuid().ToString()
New-Item -ItemType Directory -Path $runtimeProfile | Out-Null
$ownership = Join-Path $runtimeProfile '.issue100-owner'
Set-Content -LiteralPath $ownership -Value $nonce -Encoding utf8
$env:DESKTOP_EXECUTABLE = $Executable
$status = 1
try {
  & node (Join-Path $PSScriptRoot 'desktop.cjs') $State
  $status = $LASTEXITCODE
} finally {
  Remove-Item Env:DESKTOP_EXECUTABLE -ErrorAction SilentlyContinue
  if (@(Get-Process ideer-desktop -ErrorAction SilentlyContinue).Count) {
    throw "Acceptance left Desktop running; original profile preserved at $backup"
  }
  if (Test-Path -LiteralPath $runtimeProfile) {
    if (-not (Test-Path -LiteralPath $ownership) -or (Get-Content -LiteralPath $ownership -Raw).Trim() -ne $nonce) {
      throw "Profile ownership marker changed; original preserved at $backup"
    }
    $settings = Join-Path $runtimeProfile 'settings.json'
    if (Test-Path -LiteralPath $settings) {
      $references = @(Get-Content -LiteralPath (Join-Path $State 'credential-references.json') -Raw | ConvertFrom-Json)
      $active = Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json
      if ($active.business_token_ref -notin $references) {
        throw "Profile ownership changed; original preserved at $backup"
      }
    }
    # The checked path contains only the task's synthetic profile and receipts.
    if ([IO.Path]::GetFullPath($runtimeProfile) -ne (Join-Path $dataRoot 'Runtime')) { throw 'Unexpected cleanup path' }
    Remove-Item -LiteralPath $runtimeProfile -Recurse -Force
  }
  if ($moved) { Move-Item -LiteralPath $backup -Destination $runtimeProfile }
  foreach ($relative in $before.Keys) {
    if ((Get-FileHash -LiteralPath ($runtimeProfile + $relative) -Algorithm SHA256).Hash -ne $before[$relative]) {
      throw 'Existing Runtime data changed'
    }
  }
  @{ restored = $true; unchangedFiles = $before.Count; profile = 'existing current-user Runtime'; acceptanceExitCode = $status } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $State 'profile-restoration.json') -Encoding utf8
}
exit $status
