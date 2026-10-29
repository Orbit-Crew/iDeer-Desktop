---
id: issue-117-desktop-installed-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 117 installed combination acceptance on modern Windows
last-verified: 2026-10-29
verified-against: Desktop candidate worktree HEAD 82d336e (tested tree bound by installerSHA256/appASARSHA256, the develop-identical package); Server tree bound by serverSourceSHA256 3e8a3923ba727770… (equals develop f77261ce)
---

# Issue 117 installed combination acceptance, 2026-10-29

The prepared driver `scripts/acceptance/issue-117/run.ps1` was executed
end-to-end (run `exec-r23`). It installed the actual NSIS package, started
the real isolated Gateway, paired synthetic accounts A/B through the public
APIs and drove the installed application with the real model
(`agnes-3.0-flash`). Scoped graph query/ask and graph generation are
Server-orchestrated endpoints, so this driver creates no chat thread and no
Desktop Run — the Runtime SSE consumption timeout
([#37](https://github.com/Orbit-Crew/iDeer-Desktop/issues/37)) cannot affect
any wait (recorded as `runSessions: None`).

## Bindings

- Installer SHA-256 `5bb8fb587d25e1705cd21f7753d105c6d9c9f6abae46767b6fe9ead206f18ba2`;
  app.asar SHA-256 `2d1c60436a0bfc702dc29b3d5291caf92e3837c591620ea0cb4dce691efdc391`
  (the same package as the #112/#120/#114 records).
- Server tree bound at Gateway startup by `serverSourceSHA256 3e8a3923ba727770…`
  (equals develop `f77261ce` after PR #166).
- Windows 11 Pro 10.0.26300 x64; installed app 0.2.0; only the native
  picker/confirmation callbacks received synthetic inputs — IPC, Runtime,
  HTTP, authorization and storage stayed real.
- Win7 remains unexecuted and is owned by [iDeer #131](https://github.com/Orbit-Crew/iDeer/issues/131).

## Results

Evidence: [evidence/installed-20261029/](evidence/installed-20261029/).
Overall driver verdict: `incomplete` from the T117-03 staged legs below;
every case that could execute in this environment passed.

| Scenario | Status | Installed-run coverage |
| --- | --- | --- |
| T117-01 | passed | Two frozen revisions register; the view binds the frozen revision with its scope block; scope narrows only by explicit uncheck; scoped search posts the selected scope; widening reposts the explicit scope. |
| T117-02 | passed | Prevalidation refuses empty scope, malformed scope, blank query, overlong search and overlong ask; server refusals bypass the UI. |
| T117-03 | incomplete | Ask device-budget refusal, generate device-budget refusal with context reset, ask-refused-server-side-without-answer and scoped-query-over-failed-scope all passed. Staged: the structured per-document refusal payload (the #116 material-consent approval surface is not reachable in the installed app), the gapped-generation per-document category (generation parked on the material gap; the R2 graph view stayed unreachable inside the 540 s window), and the deterministic `GRAPH_CONTENT_DRIFTED` presentation (drift injection needs device-approvable material). |
| T117-04 | passed | Commands bind to the exact KB and revision; reopening the original session view does not drift. |
