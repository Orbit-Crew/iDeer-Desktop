import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

// Issue #43: the issue-112..123 installed-acceptance drivers run under
// Windows PowerShell 5.1, whose default Get-Content decoding is the ANSI
// codepage (gb2312 on the acceptance host). Reading the UTF-8
// installation.json/result.json without -Encoding UTF8 mangles Chinese text
// and ConvertFrom-Json throws ArgumentException, so installed-scenarios never
// registers and the outer command exits 1. These checks pin the encoding and
// exit-code contracts of all twelve drivers.

const DRIVER_ISSUES = [112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123]

function auditDriver(text: string): string[] {
  const violations: string[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    const where = `line ${index + 1}`
    if (line.includes('ConvertFrom-Json')) {
      if (!line.includes('Get-Content')) violations.push(`${where}: ConvertFrom-Json not fed by a Get-Content on the same line`)
      else if (!line.includes('-Encoding UTF8')) violations.push(`${where}: Get-Content feeding ConvertFrom-Json without -Encoding UTF8`)
    }
  })
  if (!lines.some(line => line.includes('command.json') && line.includes('[IO.File]::WriteAllText') && line.includes('UTF8Encoding') && line.includes('new($false)')))
    violations.push('command.json is not written as BOM-less UTF-8 via [IO.File]::WriteAllText')
  if (!lines.some(line => /exitCodeReadable\s*=/.test(line)))
    violations.push('cleanup does not record exitCodeReadable')
  const unreadable = lines.find(line => line.includes('-not $exitCodeReadable'))
  if (!unreadable) violations.push('cleanup failure condition does not test -not $exitCodeReadable')
  else if (!unreadable.includes('$code=1')) violations.push('unreadable cleanup exit code does not set $code=1')
  if (!lines.some(line => line.includes('result.json') && line.includes("status -ne 'passed'") && line.includes('$code=1')))
    violations.push('inner result.json status does not gate the outer $code')
  if (!lines.some(line => line.includes('$record.exitCode=$code'))) violations.push('record.exitCode is not bound to $code')
  const last = lines.filter(line => line.trim() !== '').pop()
  if (last !== 'exit $code') violations.push('driver does not end with exit $code')
  return violations
}

it('all twelve issue-112..123 drivers read JSON as UTF-8 and record cleanup exit-code readability', () => {
  for (const issue of DRIVER_ISSUES) {
    const text = readFileSync(resolve(`scripts/acceptance/issue-${issue}/run.ps1`), 'utf8')
    expect(auditDriver(text), `issue-${issue} driver`).toEqual([])
  }
})

it('the audit rejects the pre-fix driver shape that broke #112-#123 acceptance', () => {
  // Exact lines from scripts/acceptance/issue-120/run.ps1 at 22d968f, the
  // candidate whose twelve command.exitCode values were all 1.
  const prefix = [
    "  $meta=Get-Content -Raw (Join-Path $State 'installation.json') | ConvertFrom-Json",
    "  if(Test-Path (Join-Path $desktop 'result.json')){if((Get-Content -Raw (Join-Path $desktop 'result.json') | ConvertFrom-Json).status -ne 'passed'){$code=1}}",
    '      $exitCode=if($exited){$entry.process.ExitCode}else{$null}',
    "      $record.steps+=@{name=$entry.name+'-cleanup';exited=$exited;exitCode=$exitCode}",
    '      if(-not $exited -or $exitCode -ne 0){$code=1}',
    '  $record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $State \'command.json\')'
  ].join('\r\n')
  const violations = auditDriver(prefix).join('\n')
  expect(violations).toMatch(/-Encoding UTF8/)
  expect(violations).toMatch(/\[IO\.File\]::WriteAllText/)
  expect(violations).toMatch(/exitCodeReadable/)
  expect(violations).toMatch(/exit \$code/)
})
