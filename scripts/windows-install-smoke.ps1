$ErrorActionPreference = 'Stop'
if (-not $env:RUNNER_TEMP) { throw 'Run installation smoke in a disposable Windows CI account with RUNNER_TEMP set' }
$installer = (Get-ChildItem dist/ideer-desktop-*-windows-x64-setup.exe | Select-Object -First 1).FullName
if (-not $installer) { throw 'Installer not found' }
$installDir = Join-Path $env:RUNNER_TEMP 'ideer-desktop-installed'
$env:DESKTOP_EXECUTABLE = Join-Path $installDir 'ideer-desktop.exe'
$appData = [Environment]::GetFolderPath('ApplicationData')
$fixtureName = "ideer-install-$([guid]::NewGuid()).txt"
$legacyDir = Join-Path $appData 'linz'
$desktopDir = Join-Path $appData 'iDeer Desktop'
$legacyExisted = Test-Path $legacyDir
New-Item -ItemType Directory -Force $legacyDir, $desktopDir | Out-Null
$legacyFixture = Join-Path $legacyDir $fixtureName
$desktopFixture = Join-Path $desktopDir $fixtureName
Set-Content $legacyFixture 'old-linz-data'
Set-Content $desktopFixture 'desktop-user-data'
try {
  $install = Start-Process -FilePath $installer -ArgumentList '/S', "/D=$installDir" -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "Installation failed: $($install.ExitCode)" }
  if (-not (Test-Path $env:DESKTOP_EXECUTABLE)) { throw 'Installed executable missing' }
  node scripts/desktop-smoke.cjs
  if ($LASTEXITCODE -ne 0) { throw 'Installed Desktop smoke failed' }
} finally {
  $uninstaller = Join-Path $installDir 'Uninstall iDeer Desktop.exe'
  if (-not (Test-Path $uninstaller)) { throw 'Uninstaller missing' }
  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) { throw "Uninstall failed: $($uninstall.ExitCode)" }
  $deadline = (Get-Date).AddSeconds(30)
  while ((Test-Path $env:DESKTOP_EXECUTABLE) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (Test-Path $env:DESKTOP_EXECUTABLE) { throw 'Uninstall did not remove the executable' }
  if ((Get-Content $legacyFixture) -ne 'old-linz-data') { throw 'Legacy data changed during lifecycle' }
  if ((Get-Content $desktopFixture) -ne 'desktop-user-data') { throw 'Desktop data was removed on uninstall' }
  Remove-Item $legacyFixture, $desktopFixture
  if (-not $legacyExisted) { Remove-Item $legacyDir }
}
