---
id: issue-122-desktop-installed-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 122 installed combination acceptance on modern Windows
last-verified: 2026-10-29
verified-against: Desktop candidate worktree HEAD 82d336e (tested tree bound by installerSHA256/appASARSHA256, the develop-identical package); Server tree bound by serverSourceSHA256 3e8a3923ba727770… (equals develop f77261ce)
---

# Issue 122 installed combination acceptance, 2026-10-29

The prepared driver `scripts/acceptance/issue-122/run.ps1` was executed
end-to-end (run `exec-r17`, settled after the r9–r17 driver hardening). It
installed the actual NSIS package, started the real isolated Gateway, paired
synthetic accounts A/B through the public APIs and drove the installed
application; skill-script tasks crossed the real device broker to the
installed Runtime. Two driver-side fixture defects discovered on the way are
recorded verbatim in the evidence: the contract payloads initially dropped
`skill_id` (JSON.stringify silently discards undefined; the device gate
rightly answered the generic `SKILL_SCRIPT_INVALID` — fail-closed), and the
corruption harness initially hit the frozen storage's 0o444/0o555
immutability permissions (now lifted around the write and restored).

## Bindings

- Installer SHA-256 `5bb8fb587d25e1705cd21f7753d105c6d9c9f6abae46767b6fe9ead206f18ba2`;
  app.asar SHA-256 `2d1c60436a0bfc702dc29b3d5291caf92e3837c591620ea0cb4dce691efdc391`
  (the same package as the #112/#120/#114 records).
- Server tree bound at Gateway startup by `serverSourceSHA256 3e8a3923ba727770…`
  (equals develop `f77261ce` after PR #166).
- Windows 11 Pro 10.0.26300 x64; installed app 0.2.0; only the native
  picker/confirmation callbacks received synthetic inputs — IPC, Runtime,
  HTTP, the broker and storage stayed real.
- Win7 remains unexecuted and is owned by [iDeer #131](https://github.com/Orbit-Crew/iDeer/issues/131).

## Results

Evidence: [evidence/installed-20261029/](evidence/installed-20261029/).
Overall driver verdict: `incomplete` from the staged approval-surface legs
below; every case that could execute in this environment passed.

| Scenario | Status | Installed-run coverage |
| --- | --- | --- |
| T122-01 | incomplete | Server authorization is content-bound and its receipts carry the authorization basis and stdout hash; a user-device declaration refuses server authorization (400); the device gate refuses a server-declared skill with a typed code and an OS-mismatch payload with `SKILL_SCRIPT_ENVIRONMENT_UNAVAILABLE`. Staged: the device representative execution and the consent-approve-then-remember legs — no reachable approval surface exists for `local.skill.script` on the installed Desktop (the chat consent card filters to `local.files.write`; the tray decision surface is not attached in desktop mode). |
| T122-02 | passed | Server execute default-off (403 with the flattened envelope recorded); the admin local-task route is refused by the device fixed wire gate; offline dispatch queues as `device_offline` with an empty receipt; the receipt ledger and registry projection survive a restart. The ask legs are staged on the same approval-surface dependency (the task provably carries no result and the archive stays empty). |
| T122-03 | passed | A dependency change refuses execution (`SCRIPT_REAUTHORIZATION_REQUIRED` through the flattened envelope, asserted as text) after a fresh live grant; regranting replaces the binding and executes; a prose-only V3 bump executes on the old grant with the same requirements hash. The changed-script-bytes server category is staged (no surface republishes different script bytes into the same frozen resource). |
| T122-04 | passed | The local deny rule outranks every grant (denied, `LOCAL_POLICY_DENIED`, receipt `policy_decision: deny`); the authorization card renders with its honest empty state (one round staged on the mount-time list-IPC/restart race, with the single-slot `SKILL_SCRIPT_BUSY` gate versus the mount-render loop documented); grants never cross accounts; the revoke roundtrip refuses execution with `SCRIPT_AUTHORIZATION_REVOKED`. |
| T122-05 | incomplete | Drifted frozen bytes refuse execution before anything runs (409 `SKILL_PACKAGE_CORRUPTED` after the harness's drift is asserted applied); the script body never appears in any wire observation (execute requests carry no script text, broker dispatches carry only the SHA-256); durable projections survive the power cycle (task ledger restored, registry honestly empty). Staged: the interrupted-receipt-upload server-restart recovery (durable outbox, runtime-suite coverage). |

The flattened-envelope observation is systematic on this surface: the
gateway's global `HTTPException` handler stringifies dict details, so typed
categories arrive inside `detail` as text — the driver asserts status codes
strictly and the categories by text, retaining raw bodies as evidence.
