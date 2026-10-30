---
id: issue-43-driver-utf8-verification
kind: evidence
status: current
owner: Neowyh
scope: Issue 43 verification of the issue-112..123 acceptance drivers' UTF-8 JSON reads, exit-code passthrough and cleanup exit-code recording
last-verified: 2026-10-30
verified-against: Desktop 297eebd (driver fix cb82be7, PR #44); Windows PowerShell 5.1.26100.9711 with default codepage gb2312; archived issue-120 result.json (B1870ED9E66D6950C524306FA848ABD90CD794EE0A5682065B6EC31EF97B6BCB)
---

# Issue 43 driver UTF-8 verification

[Issue #43](https://github.com/Orbit-Crew/iDeer-Desktop/issues/43) records that
the twelve `scripts/acceptance/issue-1{12..23}/run.ps1` drivers read their
UTF-8 `installation.json`/`result.json` with `Get-Content` without an explicit
encoding. Under Windows PowerShell 5.1 the default decode is the ANSI
codepage (gb2312 on the acceptance host), Chinese text mangles, and
`ConvertFrom-Json` throws `ArgumentException` — so `installed-scenarios`
never registers, the archived `server`/`proxy` cleanup steps carry an
ambiguous `null` `ExitCode`, and all twelve outer `command.exitCode` values
were 1 even where the inner run had passed.

## What was already fixed

Commit `cb82be7` (PR #44, merged to `develop`) changed all twelve drivers to:

- read every `Get-Content ... | ConvertFrom-Json` input with `-Encoding UTF8`;
- write `command.json` as BOM-less UTF-8 via
  `[IO.File]::WriteAllText(..., [Text.UTF8Encoding]::new($false))` instead of
  the ANSI-default `Set-Content`;
- record `exitCodeReadable` for the `server`/`proxy` cleanup steps, reading
  `ExitCode` inside `try`/`catch` and treating `-not $exitCodeReadable` as
  failure instead of leaving `null` (or fabricating a zero).

The historical #112–#123 records were not modified; the corrections record
[corrections-2026-10-30-issues-112-123.md](../corrections-2026-10-30-issues-112-123.md)
keeps them as the archived baseline.

## What this record adds: repeatable verification

The fix above had no executable guard. Two artifacts now pin it:

1. **Static driver contract** — `test/acceptance-driver-encoding.test.ts`
   (runs in `npm test`, so on every PR in the `static-and-contract` job):
   audits the twelve drivers for the UTF-8 reads, the BOM-less
   `command.json` write, the `exitCodeReadable` marking with
   `-not $exitCodeReadable` → `$code=1`, the `result.json` status gating
   `$code`, and the final `exit $code`. A second test feeds the audit the
   exact pre-fix line shapes from `22d968f` and asserts they are rejected.
2. **Dynamic dual-shell proof** — `scripts/verify-issue-43.ps1` (runs in the
   `windows-package` job on every PR, and locally):
   - a BOM-less UTF-8 fixture with Chinese, escaped newlines and escaped
     quotes round-trips byte-exactly through the fixed driver idiom
     (`Get-Content -Raw -Encoding UTF8 | ConvertFrom-Json`), probed at both
     a Chinese string and the harder quote/newline detail string;
   - a `status=failed` fixture drives the child exit to 1 and a
     `status=passed` fixture to 0 — the inner-status → outer-exit-code
     passthrough, mirroring the drivers' `$code` gate;
   - on any shell whose default encoding is not UTF-8 the unencoded read
     must demonstrably fail (parse exception or corrupted text) — the #43
     defect itself reproducing as the regression guard's teeth; on
     UTF-8-default shells (pwsh) the unencoded read is expected to survive
     and is recorded as such;
   - the archived issue-120 `result.json` parses with `status=passed`
     through the fixed idiom, and fails through the unencoded idiom on this
     host — the original report's independent repro, now repeatable.

### Archived run, 2026-10-30

Host: Windows 11 Pro 10.0.26300 x64, Windows PowerShell 5.1.26100.9711,
`[Text.Encoding]::Default` = gb2312, pwsh not installed. Evidence:
[evidence/verify-20261030/verify-result.json](evidence/verify-20261030/verify-result.json)
(`gitHead` 297eebd, `scriptSha256` AB8C67F8E3F30201DA40955A1E9C321EAAE309C02EE940B8F38B72F94C575D1D;
the fixtures are archived next to the record so their recorded SHA-256 values
are verifiable in-repo;
the working tree it ran in contained exactly the files this commit adds,
and no driver file changed after `cb82be7`). All six checks passed:

| Check | Result |
| --- | --- |
| fixture passed/UTF-8, summary probe | parsed, byte-exact, child exit 0 |
| fixture passed/UTF-8, detail probe (quotes + newlines) | parsed, byte-exact, child exit 0 |
| fixture failed/UTF-8, status gate | parsed, status `failed` → child exit 1 |
| fixture passed/default read (gb2312) | defect reproduced: `System.ArgumentException` |
| archived #120 result.json, UTF-8 read | parsed, `status=passed`, Chinese title byte-exact |
| archived #120 result.json, default read (gb2312) | defect reproduced: `System.ArgumentException` (matches the original report's independent repro) |

The pwsh leg of the matrix cannot run on this host (pwsh absent). The CI
step runs `verify-issue-43.ps1` under `shell: pwsh` on `windows-2022`, where
the script drives both `powershell.exe` 5.1 and pwsh children; the
UTF-8-default pwsh expectation is recorded as "unencoded read unaffected",
and the Windows PowerShell leg re-verifies the defect environment.

## Scope limits

- This is driver-seam verification. It does **not** re-run the installed
  acceptance: the twelve candidates' re-archived command evidence remains
  pending until the fixes are packaged into a new installer and the
  re-verification campaign in
  [corrections §5](../corrections-2026-10-30-issues-112-123.md) executes
  (real WSL Gateway, real provider). Until then the archived outer
  `exitCode: 1` records stay the latest installed evidence, and issue #43's
  second acceptance box (re-archived command evidence for a fixed candidate)
  is not claimable from this record.
- The static test guards the twelve `issue-1{12..23}` drivers only; the
  older issue-100..111 scripts predate this driver generation and are out of
  the issue's scope.

## How to re-run

```powershell
. .\scripts\project-env.ps1   # if invoking tools directly on Windows
& .\scripts\verify-issue-43.ps1                       # evidence to artifacts/issue-43-verification
npx vitest run test/acceptance-driver-encoding.test.ts
```

The verification script exits nonzero when any expectation fails and writes
`verify-result.json` (BOM-less UTF-8) with per-run PS versions, default
encodings, parse outcomes, probe matches and child exits.
