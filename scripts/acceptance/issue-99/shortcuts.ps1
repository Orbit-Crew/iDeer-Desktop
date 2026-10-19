param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][string]$EvidenceDirectory
)
$ErrorActionPreference = 'Stop'
$Executable = (Resolve-Path -LiteralPath $Executable).Path
New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null
$output = Join-Path $EvidenceDirectory 'shortcut-results.json'
$shell = New-Object -ComObject WScript.Shell
$results = [System.Collections.Generic.List[object]]::new()
$owned = $null
try {
  if (@(Get-Process ideer-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Executable }).Count) {
    throw 'Close the existing installed app before this visible shortcut test.'
  }
  foreach ($shortcut in @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'iDeer Desktop.lnk'),
    (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs/iDeer Desktop.lnk')
  )) {
    if ($shell.CreateShortcut($shortcut).TargetPath -ne $Executable) { throw 'Shortcut target differs from candidate.' }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    # This is an authorized visible application-entry test, not a background helper.
    Start-Process -FilePath $shortcut -WindowStyle Normal
    $deadline = (Get-Date).AddSeconds(30)
    do {
      $owned = Get-Process ideer-desktop -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $Executable -and $_.MainWindowTitle -eq 'iDeer Desktop' -and $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1
      if ($owned) { break }
      Start-Sleep -Milliseconds 100
    } while ((Get-Date) -lt $deadline)
    if (-not $owned) { throw 'Shortcut did not open the expected application window.' }
    $processId = $owned.Id
    $null = $owned.Handle
    if (-not $owned.CloseMainWindow()) { throw 'Could not close the shortcut-launched window.' }
    if (-not $owned.WaitForExit(30000)) { throw 'Shortcut-launched main process did not exit.' }
    $exitCode = $owned.ExitCode
    if ($exitCode -ne 0) { throw "Shortcut-launched main process failed: $exitCode" }
    $deadline = (Get-Date).AddSeconds(30)
    do {
      $remaining = @(Get-Process ideer-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Executable })
      if (-not $remaining.Count) { break }
      Start-Sleep -Milliseconds 100
    } while ((Get-Date) -lt $deadline)
    if ($remaining.Count) { throw 'Shortcut-launched Desktop did not exit.' }
    $results.Add([pscustomobject]@{ shortcut = $shortcut; executable = $Executable; processId = $processId;
      title = 'iDeer Desktop'; result = 'passed'; exitCode = $exitCode; elapsedMs = $timer.ElapsedMilliseconds;
      timestamp = [DateTimeOffset]::UtcNow.ToString('o') })
    $owned = $null
  }
} catch {
  $results.Add([pscustomobject]@{ result = 'failed'; message = $_.Exception.Message })
  throw
} finally {
  if ($owned -and -not $owned.HasExited) { $owned.CloseMainWindow() | Out-Null }
  $results | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $output -Encoding utf8
}
