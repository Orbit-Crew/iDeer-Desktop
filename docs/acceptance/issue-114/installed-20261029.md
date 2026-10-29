---
id: issue-114-desktop-installed-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 114 installed combination acceptance on modern Windows
last-verified: 2026-10-29
verified-against: Desktop candidate 2bf0b2f (tree identical to develop de3b6ef, merge of #35); Server tree bound by serverSourceSHA256 3e8a3923ba727770… (equals develop f77261ce)
---

# Issue 114 installed combination acceptance, 2026-10-29

The prepared driver `scripts/acceptance/issue-114/run.ps1` was executed
end-to-end (run `exec-r4`). It installed the actual NSIS package, started the
real isolated Gateway, paired synthetic accounts A/B through the public APIs,
and drove the installed application. The scope view, the frozen run surface
and the device search contract were exercised for real. The isolated
Gateway's missing `knowledge_search` tool declaration was added to the
fixture config during debugging — the deployment veto is fail-closed by
design (`deployment_allowed_datasets` denies when the tool is unconfigured),
which is what let the run-scope bindings freeze.

## Bindings

- Installer SHA-256 `5bb8fb587d25e1705cd21f7753d105c6d9c9f6abae46767b6fe9ead206f18ba2`;
  app.asar SHA-256 `2d1c60436a0bfc702dc29b3d5291caf92e3837c591620ea0cb4dce691efdc391`
  (the same package as the #112/#120 records; tree equals Desktop develop `de3b6ef`).
- Server tree bound at Gateway startup by `serverSourceSHA256 3e8a3923ba727770…`
  (equals develop `f77261ce` after PR #166).
- Windows 11 Pro 10.0.26300 x64; installed app 0.2.0 / Electron 22.3.27; only
  the native picker/confirmation dialog callbacks received synthetic inputs —
  IPC, the bundled Runtime, HTTP, authorization and storage stayed real.
- Win7 remains unexecuted and is owned by [iDeer #131](https://github.com/Orbit-Crew/iDeer/issues/131).

## Results

Evidence: [evidence/installed-20261029/](evidence/installed-20261029/).
Overall driver verdict: `incomplete` solely from the staged dependencies
below; every case that could execute in this environment passed.

| Scenario | Status | Installed-run coverage |
| --- | --- | --- |
| T114-01 | incomplete | Scope view reads the frozen run surface (narrow_only, one local_import source with dataset `local:<revision>`, device_online), runtime selection binds the authorized frozen scope, runtime restriction cannot add an unknown KB, unanchored local KB stays out of the view — all passed; the dual-UI visual walkthrough stays unexecuted (Next.js frontend + browser session dependency). |
| T114-02 | passed | Another caller's KB is invisible end-to-end (scope view/activation/revision/run all 404; cross-account device dispatch 403 with the flattened envelope recorded). |
| T114-03 | incomplete | Real device search completes with validated chunks and a bound receipt; remote consent cannot approve device-gated search (403, envelope flattening recorded); the tampered-manifest refusal is asserted from the archived receipt; offline device reported in the scope view with a structured `device_offline` task; paused_local_required live-run and mid-retrieval disconnect stay unexecuted (model/fault-injection dependencies). |
| T114-04 | incomplete | Archived receipt and device ledger agree (capability/run_id/status/result_hash); the retrieval-receipt engine labels and the cross-engine score-merge legs need a live provider and a real model (staged); the Web selector walkthrough needs the served frontend (staged). |
