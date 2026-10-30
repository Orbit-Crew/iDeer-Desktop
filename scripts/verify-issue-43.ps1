# Issue #43 dynamic verification: the issue-112..123 installed-acceptance
# drivers must read their UTF-8 JSON as UTF-8 and pass the inner scenario
# status through to the outer exit code on every PowerShell the drivers can
# run under. This script proves that seam directly:
#   - a BOM-less UTF-8 fixture containing Chinese, escaped newlines and
#     escaped quotes must round-trip exactly through
#     `Get-Content -Raw -Encoding UTF8 | ConvertFrom-Json` in Windows
#     PowerShell 5.1 and, when installed, pwsh;
#   - a status=failed fixture must drive the child to exit 1 and a
#     status=passed fixture to exit 0 (inner status -> outer exit code);
#   - on shells whose default encoding is not UTF-8, reading the fixture
#     without -Encoding UTF8 must demonstrably corrupt it (parse failure or
#     changed text) - the #43 defect itself; on UTF-8-default shells the
#     unencoded read is expected to survive and is recorded as such;
#   - the archived issue-120 result.json (the artifact from the original
#     report) must parse with status=passed through the fixed idiom.
# The evidence record is written as BOM-less UTF-8 and the script exits
# nonzero when any expectation fails. This is a driver-seam check; it does
# not re-run the installed acceptance itself (see
# docs/acceptance/corrections-2026-10-30-issues-112-123.md section 5).
param([string]$EvidenceDirectory = 'artifacts/issue-43-verification')

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
# .NET file APIs ([IO.File]::WriteAllText, [IO.Path]::GetFullPath) resolve
# relative paths against the process working directory, which differs from
# PowerShell's location whenever the parent shell launched this script from
# elsewhere. Sync them before resolving any relative path.
[Environment]::CurrentDirectory = (Get-Location).Path
$EvidenceDirectory = [IO.Path]::GetFullPath($EvidenceDirectory)
New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null

# Expected fixture text is carried as base64 so this file stays pure ASCII:
# Windows PowerShell 5.1 decodes BOM-less .ps1 sources with the ANSI
# codepage, so non-ASCII literals in this file would be mangled exactly the
# way the drivers' JSON inputs were.
$expectedSummary = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('6aqM5pS26YCa6L+H77ya5Lit5paH44CB5o2i6KGM5LiO5byV5Y+3'))
$expectedDetail = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('56ys5LiA6KGMIuWPjOW8leWPtyIK56ys5LqM6KGMIuW8leWPt+S4juaNouihjCIK56ys5LiJ6KGMJ+WNleW8leWPtyc='))
$summaryB64 = '6aqM5pS26YCa6L+H77ya5Lit5paH44CB5o2i6KGM5LiO5byV5Y+3'
$detailB64 = '56ys5LiA6KGMIuWPjOW8leWPtyIK56ys5LqM6KGMIuW8leWPt+S4juaNouihjCIK56ys5LiJ6KGMJ+WNleW8leWPtyc='

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function ConvertTo-Utf8Base64([string]$Text) {
  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Text))
}

$summaryJson = $expectedSummary.Replace('\', '\\').Replace('"', '\"')
$detailJson = $expectedDetail.Replace('\', '\\').Replace('"', '\"').Replace("`n", '\n')
$passedJson = '{"status":"passed","summary":"' + $summaryJson + '","detail":"' + $detailJson + '"}'
$failedJson = '{"status":"failed","summary":"' + $summaryJson + '","detail":"' + $detailJson + '"}'
$passedFixturePath = Join-Path $EvidenceDirectory 'fixture-passed.json'
$failedFixturePath = Join-Path $EvidenceDirectory 'fixture-failed.json'
Write-Utf8NoBom $passedFixturePath $passedJson
Write-Utf8NoBom $failedFixturePath $failedJson

$childScriptPath = Join-Path $EvidenceDirectory 'probe-child.ps1'
$childScript = @'
param(
  [Parameter(Mandatory=$true)][string]$FixturePath,
  [Parameter(Mandatory=$true)][string]$Mode,
  [Parameter(Mandatory=$true)][string]$ResultPath,
  [string]$ProbePath = 'status'
)
$ErrorActionPreference = 'Stop'
$report = [ordered]@{
  psVersion = $PSVersionTable.PSVersion.ToString()
  edition = $PSVersionTable.PSEdition
  defaultEncoding = [Text.Encoding]::Default.WebName
  mode = $Mode
  parsed = $false
  status = $null
  probeB64 = $null
}
try {
  $raw = Get-Content -LiteralPath $FixturePath -Raw -Encoding UTF8
  if ($Mode -eq 'default') { $raw = Get-Content -LiteralPath $FixturePath -Raw }
  $value = $raw | ConvertFrom-Json
  $report.parsed = $true
  $report.status = $value.status
  $probe = $value
  foreach ($segment in $ProbePath.Split('.')) {
    if ($probe -is [array]) { $probe = $probe[[int]$segment] } else { $probe = $probe.$segment }
  }
  $report.probeB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$probe))
} catch {
  $report.parseError = $_.Exception.GetType().FullName
}
$reportJson = $report | ConvertTo-Json
[IO.File]::WriteAllText($ResultPath, $reportJson, [Text.UTF8Encoding]::new($false))
# The drivers gate the outer exit code on the inner scenario status:
# `if((Get-Content ... | ConvertFrom-Json).status -ne 'passed'){$code=1}`.
if ($report.parsed -and $report.status -eq 'passed') { exit 0 }
exit 1
'@
Write-Utf8NoBom $childScriptPath $childScript

$archivedPath = 'docs/acceptance/issue-120/evidence/installed-20261029/result.json'
$archivedTitleB64 = $null
if (Test-Path -LiteralPath $archivedPath) {
  $archived = Get-Content -LiteralPath $archivedPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $archivedTitle = ($archived.scenarios.'T120-01'.cases)[0].confirmation.title
  $archivedTitleB64 = ConvertTo-Utf8Base64 ([string]$archivedTitle)
}

$shells = @()
$windowsPowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (Test-Path -LiteralPath $windowsPowerShell) {
  $shells += @{ key = 'windows-powershell'; exe = $windowsPowerShell }
}
$pwshCommand = Get-Command pwsh -ErrorAction SilentlyContinue
if ($pwshCommand) {
  $shells += @{ key = 'pwsh'; exe = $pwshCommand.Source }
}
if ($shells.Count -eq 0) { throw 'No PowerShell interpreter found to verify with' }

$gitHead = 'unavailable'
try {
  $headLine = (& git rev-parse HEAD) 2>$null
  if ($LASTEXITCODE -eq 0 -and $headLine) { $gitHead = ([string]$headLine).Trim() }
} catch { }

$violations = [System.Collections.Generic.List[string]]::new()
$shellReports = @()

function Invoke-Probe([string]$Exe, [hashtable]$Run, [string]$Key) {
  $resultPath = Join-Path $EvidenceDirectory ($Run.name + '-' + $Key + '-result.json')
  & $Exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $childScriptPath `
    -FixturePath $Run.fixture -Mode $Run.mode -ResultPath $resultPath `
    -ProbePath $Run.probePath
  $exit = $LASTEXITCODE
  $result = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
  return @{ exit = $exit; result = $result }
}

foreach ($shell in $shells) {
  $runs = @(
    @{ name = 'fixture-passed-utf8-summary'; fixture = $passedFixturePath; mode = 'utf8'; probePath = 'summary'; expectedProbeB64 = $summaryB64; expectExit = 0 },
    @{ name = 'fixture-passed-utf8-detail'; fixture = $passedFixturePath; mode = 'utf8'; probePath = 'detail'; expectedProbeB64 = $detailB64; expectExit = 0 },
    @{ name = 'fixture-failed-utf8-status-gate'; fixture = $failedFixturePath; mode = 'utf8'; probePath = 'status'; expectedProbeB64 = (ConvertTo-Utf8Base64 'failed'); expectExit = 1 },
    @{ name = 'fixture-passed-default-summary'; fixture = $passedFixturePath; mode = 'default'; probePath = 'summary'; expectedProbeB64 = $summaryB64; defectProbe = $true },
    @{ name = 'archived-utf8-title'; fixture = $archivedPath; mode = 'utf8'; probePath = 'scenarios.T120-01.cases.0.confirmation.title'; expectedProbeB64 = $archivedTitleB64; expectExit = 0 },
    @{ name = 'archived-default-title'; fixture = $archivedPath; mode = 'default'; probePath = 'scenarios.T120-01.cases.0.confirmation.title'; expectedProbeB64 = $archivedTitleB64; defectProbe = $true }
  )
  $runReports = @()
  foreach ($run in $runs) {
    $violationsBefore = $violations.Count
    if (-not $run.defectProbe -and $null -eq $run.expectedProbeB64) {
      $violations.Add("$($run.name): skipped, expected probe value unavailable") | Out-Null
      continue
    }
    $outcome = Invoke-Probe $shell.exe $run $shell.key
    $result = $outcome.result
    $probeMatch = ($result.probeB64 -ceq $run.expectedProbeB64)
    $note = $null
    if ($run.defectProbe) {
      if ($result.defaultEncoding -like 'utf-8*') {
        if (-not ($result.parsed -and $probeMatch -and $outcome.exit -eq 0)) {
          $violations.Add("$($run.name): default encoding is UTF-8 so the unencoded read should parse faithfully") | Out-Null
        } else {
          $note = 'default encoding is UTF-8; unencoded read unaffected'
        }
      } elseif ($result.parsed -and $probeMatch) {
        $violations.Add("$($run.name): unencoded read on default encoding $($result.defaultEncoding) did not corrupt the text; the #43 defect did not reproduce") | Out-Null
      } else {
        if ($result.parseError) { $note = "defect reproduced as $($result.parseError)" } else { $note = 'defect reproduced as corrupted text' }
      }
    } else {
      if (-not $result.parsed) {
        $violations.Add("$($run.name): UTF-8 read failed to parse: $($result.parseError)") | Out-Null
      } elseif (-not $probeMatch) {
        $violations.Add("$($run.name): parsed text differs from the expected UTF-8 content") | Out-Null
      } elseif ($outcome.exit -ne $run.expectExit) {
        $violations.Add("$($run.name): inner status $($result.status) produced exit $($outcome.exit), expected $($run.expectExit)") | Out-Null
      }
    }
    $runReports += @{
      name = $run.name
      mode = $run.mode
      childExit = $outcome.exit
      psVersion = $result.psVersion
      edition = $result.edition
      defaultEncoding = $result.defaultEncoding
      parsed = [bool]$result.parsed
      status = $result.status
      probeMatched = $probeMatch
      parseError = $result.parseError
      note = $note
    }
    $label = 'PASS'
    if ($violations.Count -gt $violationsBefore) { $label = 'FAIL' }
    Write-Output ("[{0}] {1}/{2} default={3} exit={4} {5}" -f $label, $shell.key, $run.name, $result.defaultEncoding, $outcome.exit, $note)
  }
  $shellReports += @{
    key = $shell.key
    exe = $shell.exe
    runs = $runReports
  }
}

$os = $null
try { $os = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSArchitecture } catch { }
$archivedEvidence = @{ path = $archivedPath; missing = $true }
if ($archivedTitleB64) {
  $archivedEvidence = @{ path = $archivedPath; sha256 = (Get-FileHash -LiteralPath $archivedPath -Algorithm SHA256).Hash }
}
$evidence = [ordered]@{
  generatedAt = [DateTimeOffset]::Now.ToString('o')
  check = 'issue-43-driver-utf8-verification'
  gitHead = $gitHead
  scriptSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash
  os = $os
  archivedResultJson = $archivedEvidence
  fixtures = [ordered]@{
    passed = @{ path = $passedFixturePath; sha256 = (Get-FileHash -LiteralPath $passedFixturePath -Algorithm SHA256).Hash; content = $passedJson }
    failed = @{ path = $failedFixturePath; sha256 = (Get-FileHash -LiteralPath $failedFixturePath -Algorithm SHA256).Hash; content = $failedJson }
  }
  shells = $shellReports
  violations = $violations
  passed = ($violations.Count -eq 0)
}
$evidencePath = Join-Path $EvidenceDirectory 'verify-result.json'
Write-Utf8NoBom $evidencePath ($evidence | ConvertTo-Json -Depth 8)
Write-Output "Evidence: $evidencePath"
if ($violations.Count -gt 0) { exit 1 }
exit 0
