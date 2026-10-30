# Dot-source once before direct npm, Python, uv, or acceptance commands:
# . .\scripts\project-env.ps1
param([switch]$PersistCaches)

$projectEnvRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$projectEnvJson = & node (Join-Path $PSScriptRoot 'project-env.cjs') --print-env
if ($LASTEXITCODE -ne 0) { throw 'Cannot initialize project paths. Use Node 22 or newer.' }
$projectEnvPaths = $projectEnvJson | ConvertFrom-Json
if ($PersistCaches) {
    $projectEnvBackup = Join-Path $projectEnvRoot 'artifacts\disk-audit'
    New-Item -ItemType Directory -Path $projectEnvBackup -Force | Out-Null
    $projectEnvPrevious = [ordered]@{}
    foreach ($projectEnvProperty in $projectEnvPaths.PSObject.Properties) {
        if ($projectEnvProperty.Name -in @('TEMP', 'TMP', 'TMPDIR')) { continue }
        $projectEnvPrevious[$projectEnvProperty.Name] = [Environment]::GetEnvironmentVariable($projectEnvProperty.Name, 'User')
    }
    $projectEnvBackupFile = Join-Path $projectEnvBackup ('user-cache-env-before-' + [guid]::NewGuid().ToString('N') + '.json')
    $projectEnvPrevious | ConvertTo-Json | Set-Content -LiteralPath $projectEnvBackupFile -Encoding utf8
    foreach ($projectEnvProperty in $projectEnvPaths.PSObject.Properties) {
        if ($projectEnvProperty.Name -in @('TEMP', 'TMP', 'TMPDIR')) { continue }
        [Environment]::SetEnvironmentVariable($projectEnvProperty.Name, $projectEnvProperty.Value, 'User')
    }
    Write-Output "Future tool processes will use project caches. Previous settings: $projectEnvBackupFile"
}
foreach ($projectEnvProperty in $projectEnvPaths.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($projectEnvProperty.Name, $projectEnvProperty.Value, 'Process')
}
Write-Output "Project caches: $(Join-Path $projectEnvRoot '.cache')"
Write-Output "This shell's temporary files: $($projectEnvPaths.TEMP)"
