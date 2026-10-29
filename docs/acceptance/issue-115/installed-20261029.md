---
id: issue-115-desktop-installed-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 115 installed combination acceptance on modern Windows
last-verified: 2026-10-29
verified-against: Desktop candidate worktree HEAD 82d336e (tested tree bound by installerSHA256/appASARSHA256, the develop-identical package); Server tree bound by serverSourceSHA256 3e8a3923ba727770… (equals develop f77261ce)
---

# Issue 115 installed combination acceptance, 2026-10-29

The prepared driver `scripts/acceptance/issue-115/run.ps1` was executed
end-to-end (run `exec-r11`). It installed the actual NSIS package, started
the real isolated Gateway, paired synthetic accounts A/B through the public
APIs and drove the installed application. No model was called
(`modelsCalled: false`); the preview/guard surface is fully local.

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
Overall driver verdict: `incomplete` from the staged confirmed-publish leg
below; every case that could execute in this environment passed.

| Scenario | Status | Installed-run coverage |
| --- | --- | --- |
| T115-01 | passed | The unconfirmed-workspace guard holds in the installed app, and the UI preview-cancel walkthrough completes (screenshot archived). The publish-cancel-dialog leg is unexecuted with the recorded observation: the confirmation dialog never opened and no IPC rejection surfaced; the refusal (no upload) is asserted from the wire data instead. |
| T115-02 | unexecuted | The installed Runtime confirmed-publish stalled before any platform POST: preview GETs only, no upload and no registry row after the 300 s window — recorded with the wire tail as a candidate defect observation. The exact-bytes multipart contract remains covered by the automated suites. |
| T115-03 | unexecuted | Behind the T115-02 upload dependency. |
| T115-04 | unexecuted | Behind the T115-02 upload dependency. |
