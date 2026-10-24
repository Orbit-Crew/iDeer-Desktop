# Issue 110 acceptance

[iDeer #110](https://github.com/Orbit-Crew/iDeer/issues/110) gates the running
Desktop/Runtime combination against a signed, Server-provided compatibility
declaration: compatible, single-capability stop, or core incompatibility that
stops new local tasks. A capability switch never grants anything — Server
authorization and local policy still decide every request, and history,
unconfirmed execution records and unknown tasks stay exactly as they are in
every level. Prerequisites #98 (closed) and #107 (closed 2026-10-24).

Execution date: 2026-10-24, Asia/Shanghai. Automated execution only.

## Candidate and environment

Desktop branch `feat/issue-110` from develop `06e2a664453254451654455adc8d9cd4ce6fa657`.
Windows 11 Pro 10.0.26300 x64; Node 22.14.0; Electron 22.3.27; bundled Runtime
Python 3.12.10. The declaration is served from the paired Server's controlled
address (`updates/compatibility.json` + detached Ed25519 signature) with the
same pinned public key and origin rules as the update manifests.

## What was delivered

- `src/main/compat.ts`: signed declaration verification (detached Ed25519),
  schema checks (level whitelist, capability whitelist, compatible/core must
  not carry disabled lists, protocol floor), the level semantics, and the
  controlled-address fetch with honest `COMPAT_NOT_PUBLISHED` behavior.
- Hard stop in the main process: `desktop:chat` refuses `create`/`send` at the
  core level (`COMPAT_TASK_STOPPED`); the capability level stops only sends
  whose capability is declared disabled. Reads, history, consent, stop and
  receipt paths stay available at every level, so unknown tasks are never
  treated as executed and nothing is deleted.
- `desktop:compatibility:refresh` (main-frame-gated), the `CompatibilityPanel`
  UI (level, disabled capabilities, candidate combination, notes, advice, and
  an honest missing-declaration state), and the shared view types.

## Scenario results (vitest `test/compat-gate.test.ts`, 4 new cases, all passed)

| Scenario | Evidence | Result |
| --- | --- | --- |
| T110-01 (three controlled levels; affected and unaffected requests) | the three levels evaluate with exact semantics; the capability level stops exactly the disabled capability's sends while other sends run; core stops create/send and leaves state/refresh/open/reconnect/stop/answer/consent/upload available | passed |
| T110-02 (switch without authority) | the gate only blocks: Server authorization and local policy are untouched (no capability, grant or policy code changed in this issue); a disabled capability in the gate still requires the normal consent/approval flow before any effect | passed |
| T110-03 (core incompatibility preserves records) | no code path in the gate writes or deletes anything; records, receipts and unknown tasks are unaffected by the level (structural: the gate only throws before dispatch) | passed |
| T110-04 (declared combinations actually exercised; no unverified rolling-upgrade claim) | the controlled-address fixture serves the capability-level declaration and the Desktop evaluates it end to end; the candidate combination fields (desktop/runtime/server) are carried in the declaration and shown in the UI; rolling-upgrade behavior beyond the declared combinations is not claimed | passed |

## Executed commands

| Command | Result |
| --- | --- |
| `npm.cmd run typecheck` | passed |
| `npm.cmd test` | 44 passed, 16 files (40 baseline + 4 new) |
| `npm.cmd run test:security` | passed (boundary includes `desktop:compatibility:refresh`) |
| `npm.cmd run verify:provenance` / `scripts/verify-runtime-source.py` | passed |
| `ruff check local-runtime --select E9,F63,F7,F82` | passed (no Runtime changes) |

## Server workflow dependencies — delivered

The Server repository delivered the publication side: PR #144 (merged as
`169c17549facbe04096600c9b0c4e6359127dc53`) serves the signed declaration at
the controlled address, and PR #145 (merged as
`591f80cf3579fcd3ec527d79fa9a867f6f4fc32d`) adds the maintainer signing tool
with cross-side contract tests — a published declaration always parses on the
Desktop, and all seven structural rejections are covered there. The release
coordination order stands: publish the Server's own compatibility declaration
first, verify old clients, then introduce new clients; combinations beyond the
declared candidate remain unclaimed. Real Win7 remains `unexecuted` under
[#131](https://github.com/Orbit-Crew/iDeer/issues/131).
